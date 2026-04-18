#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';
import { startDashboard } from './dashboard.js';

async function main() {
  const port = parseInt(process.env.AGENT_KNOWLEDGE_PORT || '3423', 10);

  let isLeader = false;
  try {
    await startDashboard(port);
    process.stderr.write(`Dashboard: http://localhost:${port}\n`);
    isLeader = true;
  } catch {
    process.stderr.write(
      `[knowledge] Dashboard port ${port} in use — another instance is leader.\n`,
    );
  }

  const server = createServer({ isLeader });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
