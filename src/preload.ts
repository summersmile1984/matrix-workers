// Preload script — must be the FIRST thing Bun executes.
// Registers the `cloudflare:workers` virtual module so that Durable Object
// and Workflow classes can import it without modification.
//
// Run via:  bun run src/preload.ts
// (package.json "start" and "dev:local" scripts should use this file)

// @ts-ignore — Bun-specific API
Bun.plugin({
    name: 'cloudflare-workers-shim',
    setup(build: any) {
        build.module('cloudflare:workers', () => {
            return {
                exports: {
                    DurableObject: class DurableObject {
                        ctx: any;
                        env: any;
                        constructor(ctx: any, env: any) {
                            this.ctx = ctx;
                            this.env = env;
                        }
                    },
                    WorkflowEntrypoint: class WorkflowEntrypoint {
                        ctx: any;
                        env: any;
                        constructor(ctx: any, env: any) {
                            this.ctx = ctx;
                            this.env = env;
                        }
                        async run(_event: any, _step: any): Promise<void> {
                            throw new Error('Workflows not supported in self-hosted mode');
                        }
                    },
                },
                loader: 'object',
            };
        });
    },
});

// Dynamically import the actual server after the plugin is registered
await import('./server.ts');
