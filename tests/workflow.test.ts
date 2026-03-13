// Integration test for Mastra workflow bindings.
// Validates that the CF Workflow API bridge works correctly:
//   - create() returns an instance with id and status()
//   - Workflow steps execute with requestContext (env)
//   - status() returns the correct result shape
//
// This test creates a real Mastra instance with in-memory-like libSQL,
// registers a simple test workflow, and runs it through the adapter.
//
// Run: LIBSQL_URL=http://localhost:8080 bun test tests/workflow.test.ts

import { describe, test, expect, beforeAll } from 'vitest';
import { Mastra } from '@mastra/core/mastra';
import { LibSQLStore } from '@mastra/libsql';
import { createWorkflow, createStep } from '@mastra/core/workflows';
import { z } from 'zod';
import { createMastraWorkflowBinding } from '../src/adapters/mastra-workflow-adapter';
import { RequestContext } from '@mastra/core/request-context';

// ── Test Workflow ──────────────────────────────────────────────────────────────
// A simple workflow that accesses env via requestContext

const addStep = createStep({
    id: 'add',
    inputSchema: z.object({ a: z.number(), b: z.number() }),
    outputSchema: z.object({ sum: z.number(), serverName: z.string() }),
    execute: async ({ inputData, requestContext }) => {
        const env = (requestContext as any).get('env');
        return {
            sum: inputData.a + inputData.b,
            serverName: env?.SERVER_NAME ?? 'unknown',
        };
    },
});

const testWorkflow = createWorkflow({
    id: 'test-add-workflow',
    inputSchema: z.object({ a: z.number(), b: z.number() }),
    outputSchema: z.object({ sum: z.number(), serverName: z.string() }),
})
    .then(addStep)
    .commit();

// ── Multi-step workflow with retries ──────────────────────────────────────────

let stepCallCount = 0;

const flakyStep = createStep({
    id: 'flaky',
    inputSchema: z.object({ message: z.string() }),
    outputSchema: z.object({ processed: z.string(), attempts: z.number() }),
    retries: 3,
    execute: async ({ inputData }) => {
        stepCallCount++;
        // Succeed on the first try for the test (we mainly validate the retry config doesn't break)
        return {
            processed: inputData.message.toUpperCase(),
            attempts: stepCallCount,
        };
    },
});

const retryWorkflow = createWorkflow({
    id: 'test-retry-workflow',
    inputSchema: z.object({ message: z.string() }),
    outputSchema: z.object({ processed: z.string(), attempts: z.number() }),
})
    .then(flakyStep)
    .commit();

// ── Setup ──────────────────────────────────────────────────────────────────────

let mastra: Mastra;
const DOMAIN = process.env.DOMAIN || 'localhost';
const LIBSQL_URL = process.env.LIBSQL_URL || `http://127.0.0.1:8080`;

beforeAll(async () => {
    const storage = new LibSQLStore({
        id: 'matrix-workers-test',
        url: LIBSQL_URL,
    });

    mastra = new Mastra({
        storage,
        workflows: {
            testWorkflow,
            retryWorkflow,
        },
    });

    // Wait for Mastra to initialize storage tables
    await new Promise(resolve => setTimeout(resolve, 2000));
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('Mastra Workflow Adapter', () => {

    test('createMastraWorkflowBinding returns correct API shape', () => {
        const env = { SERVER_NAME: 'test.local' };
        const binding = createMastraWorkflowBinding(mastra, 'testWorkflow', env);

        expect(binding).toBeDefined();
        expect(typeof binding.create).toBe('function');
    });

    test('create() returns instance with id and status()', async () => {
        const env = { SERVER_NAME: 'test.local' };
        const binding = createMastraWorkflowBinding(mastra, 'testWorkflow', env);

        const instance = await binding.create({
            params: { a: 3, b: 7 },
        });

        expect(instance).toBeDefined();
        expect(typeof instance.id).toBe('string');
        expect(instance.id.length).toBeGreaterThan(0);
        expect(typeof instance.status).toBe('function');
        expect(typeof instance.pause).toBe('function');
        expect(typeof instance.resume).toBe('function');
        expect(typeof instance.terminate).toBe('function');
    });

    test('workflow executes and status() returns result', async () => {
        const env = { SERVER_NAME: 'workflow-test.local' };
        const binding = createMastraWorkflowBinding(mastra, 'testWorkflow', env);

        const instance = await binding.create({
            params: { a: 10, b: 20 },
        });

        // Wait for workflow to complete
        const result = await instance.status();

        expect(result.status).toBe('complete');
        expect(result.output).toBeDefined();
        expect((result.output as any).sum).toBe(30);
        expect((result.output as any).serverName).toBe('workflow-test.local');
    });

    test('requestContext passes env to workflow steps', async () => {
        const env = { SERVER_NAME: 'rc-test.matrix.org' };
        const binding = createMastraWorkflowBinding(mastra, 'testWorkflow', env);

        const instance = await binding.create({
            params: { a: 1, b: 2 },
        });

        const result = await instance.status();
        expect(result.status).toBe('complete');
        expect((result.output as any).serverName).toBe('rc-test.matrix.org');
    });

    test('workflow with retries config executes successfully', async () => {
        stepCallCount = 0;
        const env = {};
        const binding = createMastraWorkflowBinding(mastra, 'retryWorkflow', env);

        const instance = await binding.create({
            params: { message: 'hello world' },
        });

        const result = await instance.status();
        expect(result.status).toBe('complete');
        expect((result.output as any).processed).toBe('HELLO WORLD');
    });
});

describe('Mastra Workflow Direct Execution', () => {

    test('workflow runs via Mastra.getWorkflow().createRun().start()', async () => {
        const workflow = mastra.getWorkflow('testWorkflow');
        const run = await workflow.createRun();

        const rc = new RequestContext([['env', { SERVER_NAME: 'direct.test' }]]);
        const result = await run.start({
            inputData: { a: 42, b: 58 },
            requestContext: rc as any,
        });

        expect(result.status).toBe('success');
        if (result.status === 'success') {
            expect(result.result).toBeDefined();
            expect((result.result as any).sum).toBe(100);
            expect((result.result as any).serverName).toBe('direct.test');
        }
    });

    test('workflow result includes step details', async () => {
        const workflow = mastra.getWorkflow('testWorkflow');
        const run = await workflow.createRun();

        const rc = new RequestContext([['env', { SERVER_NAME: 'steps.test' }]]);
        const result = await run.start({
            inputData: { a: 5, b: 3 },
            requestContext: rc as any,
        });

        expect(result.status).toBe('success');
        expect(result.steps).toBeDefined();
        // The 'add' step should be in the results
        expect(result.steps['add']).toBeDefined();
    });
});

describe('Workflow Error Handling', () => {

    test('status() wraps workflow failure as errored', async () => {
        // Create a workflow that always fails
        const failStep = createStep({
            id: 'fail',
            inputSchema: z.object({ x: z.number() }),
            outputSchema: z.object({ y: z.number() }),
            execute: async () => {
                throw new Error('Intentional test failure');
            },
        });

        const failWorkflow = createWorkflow({
            id: 'test-fail-workflow',
            inputSchema: z.object({ x: z.number() }),
            outputSchema: z.object({ y: z.number() }),
        })
            .then(failStep)
            .commit();

        const failMastra = new Mastra({
            storage: new LibSQLStore({
                id: 'matrix-workers-test-fail',
                url: LIBSQL_URL,
            }),
            workflows: { failWorkflow },
        });

        await new Promise(resolve => setTimeout(resolve, 1000));

        const binding = createMastraWorkflowBinding(failMastra, 'failWorkflow', {});
        const instance = await binding.create({ params: { x: 1 } });

        const result = await instance.status();
        expect(result.status).toBe('errored');
        expect(result.output).toBeDefined();
        expect((result.output as any).success).toBe(false);
    });
});
