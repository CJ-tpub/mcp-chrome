import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { setupTools } from './register-tools';

/**
 * Create an MCP Server instance bound to the current native-messaging bridge.
 *
 * IMPORTANT: an MCP SDK `Server` may only ever be connected to a single
 * transport. We therefore create one instance per Streamable-HTTP session
 * instead of sharing a module-level singleton (which used to fail with
 * "Already connected to a transport" and could only be cleared by killing
 * the native host).
 */
export function createMcpServer(): Server {
  const server = new Server(
    {
      name: 'ChromeMcpServer',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  setupTools(server);
  return server;
}

/** Legacy accessor kept for the stdio entry point (single-connection by design). */
let stdioServer: Server | null = null;
export const getMcpServer = (): Server => {
  if (!stdioServer) {
    stdioServer = createMcpServer();
  }
  return stdioServer;
};
