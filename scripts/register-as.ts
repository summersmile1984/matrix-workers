import { createClient } from "@libsql/client/http";
const client = createClient({ url: "http://localhost:8080" });

const id = "agent-bridge";
const asToken = "74a264c95f0d40b9a097d11c0489d3e15ef410b639cd49bfae81fda06748c3a8";
const hsToken = "741a94d24c8e4482acfa93ed6dba65469f3aeab51c2940b494b285a24ed84c36";
const senderLocalpart = "bridge-bot";
const url = "https://bridge.localhost";
const namespaces = JSON.stringify([{ exclusive: true, regex: "@e2e_.*" }]);

await client.execute({
    sql: "INSERT OR REPLACE INTO appservice_registrations (id, url, as_token, hs_token, sender_localpart, rate_limited, namespaces, created_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)",
    args: [id, url, asToken, hsToken, senderLocalpart, namespaces, Date.now()]
});
console.log("AppService registered successfully.");
