// Matrix VoIP endpoints (TURN server credentials + call member cleanup)

import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { requireAuth } from '../middleware/auth';
import { getMatrixTurnCredentials, getStunServers, isTurnConfigured, TurnError } from '../services/turn';

const app = new Hono<AppEnv>();

// GET /_matrix/client/v3/voip/turnServer - Get TURN server credentials
// Spec: https://spec.matrix.org/v1.12/client-server-api/#get_matrixclientv3voipturnserver
app.get('/_matrix/client/v3/voip/turnServer', requireAuth(), async (c) => {
  const userId = c.get('userId');

  // Check if TURN is configured
  if (!isTurnConfigured(c.env)) {
    // Return STUN-only servers when TURN is not configured
    // This still helps with NAT traversal for direct connections
    return c.json(getStunServers());
  }

  try {
    // Get credentials with 1 hour TTL (good balance of security and usability)
    // Pass userId for per-user rate limiting
    const creds = await getMatrixTurnCredentials(c.env, 3600, userId);
    // Don't log credentials - they are sensitive
    console.log('[voip] TURN credentials generated successfully');
    return c.json(creds);
  } catch (error) {
    if (error instanceof TurnError) {
      console.error(`TURN error [${error.code}]: ${error.message}`);

      // For per-user rate limiting, return 429 with retry info
      if (error.code === 'USER_RATE_LIMITED') {
        return c.json({
          errcode: 'M_LIMIT_EXCEEDED',
          error: 'Too many TURN credential requests. Please try again later.',
          retry_after_ms: error.retryAfterMs || 60000,
        }, 429);
      }

      // For Cloudflare API rate limiting, return 429 to client
      if (error.code === 'RATE_LIMITED') {
        return c.json({
          errcode: 'M_LIMIT_EXCEEDED',
          error: 'TURN credential requests are rate limited. Please try again later.',
          retry_after_ms: 60000,
        }, 429);
      }

      // For other errors, return STUN-only (graceful degradation)
      // Clients will work without TURN, just may have connectivity issues behind NAT
      return c.json(getStunServers());
    }

    // Unexpected error - still return STUN servers
    console.error('Unexpected TURN error:', error);
    return c.json(getStunServers());
  }
});

// ============================================
// Call Member Expiry Cleanup (MSC3401)
// ============================================
// Expired m.call.member memberships should be cleaned up so stale calls
// don't linger indefinitely. This is called on-demand during sync or
// can be triggered by a periodic cron/workflow.

/**
 * Clean up expired m.call.member state events in all rooms.
 * For each user's call membership, checks expires_ts and removes
 * expired entries by sending an updated state event with empty memberships.
 */
export async function cleanupExpiredCallMembers(
  db: D1Database
): Promise<{ cleaned: number }> {
  const now = Date.now();
  let cleaned = 0;

  // Find all m.call.member state events by joining room_state with events
  const callMemberEvents = await db.prepare(`
    SELECT rs.room_id, rs.state_key, rs.event_id, e.content
    FROM room_state rs
    JOIN events e ON rs.event_id = e.event_id
    WHERE rs.event_type = 'm.call.member'
  `).all<{
    room_id: string;
    state_key: string;
    event_id: string;
    content: string;
  }>();

  for (const row of callMemberEvents.results) {
    try {
      const content = JSON.parse(row.content);
      const memberships = content.memberships || [];

      // Filter out expired memberships
      const activeMemberships = memberships.filter(
        (m: { expires_ts?: number }) => !m.expires_ts || m.expires_ts > now
      );

      // If some memberships were removed, update the state
      if (activeMemberships.length < memberships.length) {
        const newContent = { memberships: activeMemberships };
        const eventId = `$${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;

        // Insert new event
        await db.prepare(`
          INSERT INTO events (event_id, room_id, sender, event_type, state_key, content, origin_server_ts, depth, auth_events, prev_events)
          VALUES (?, ?, ?, 'm.call.member', ?, ?, ?, 0, '[]', '[]')
        `).bind(
          eventId,
          row.room_id,
          row.state_key,  // state_key is the user_id
          row.state_key,
          JSON.stringify(newContent),
          now
        ).run();

        // Update room_state to point to new event
        await db.prepare(`
          INSERT OR REPLACE INTO room_state (room_id, event_type, state_key, event_id)
          VALUES (?, 'm.call.member', ?, ?)
        `).bind(row.room_id, row.state_key, eventId).run();

        cleaned += memberships.length - activeMemberships.length;
        console.log(
          `[voip] Cleaned ${memberships.length - activeMemberships.length} expired call memberships`,
          `for user ${row.state_key} in room ${row.room_id}`
        );
      }
    } catch (e) {
      console.error('[voip] Error cleaning up call member:', row.event_id, e);
    }
  }

  return { cleaned };
}

export default app;
