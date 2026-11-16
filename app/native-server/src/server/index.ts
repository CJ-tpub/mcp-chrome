/**
 * HTTP Server - Core server implementation.
 *
 * Responsibilities:
 * - Fastify instance management
 * - Plugin registration (CORS, etc.)
 * - Route delegation to specialized modules
 * - MCP transport handling
 * - Server lifecycle management
 */
import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import {
  NATIVE_SERVER_PORT,
  TIMEOUTS,
  SERVER_CONFIG,
  HTTP_STATUS,
  ERROR_MESSAGES,
} from '../constant';
import { NativeMessagingHost } from '../native-messaging-host';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomUUID } from 'node:crypto';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer } from '../mcp/mcp-server';
import type { Server as McpServerType } from '@modelcontextprotocol/sdk/server/index.js';
import { AgentStreamManager } from '../agent/stream-manager';
import { AgentChatService } from '../agent/chat-service';
import { CodexEngine } from '../agent/engines/codex';
import { ClaudeEngine } from '../agent/engines/claude';
import { closeDb } from '../agent/db';
import { registerAgentRoutes } from './routes';

// ============================================================
// Types
// ============================================================

interface ExtensionRequestPayload {
  data?: unknown;
}

// ============================================================
// Server Class
// ============================================================

export class Server {
  private fastify: FastifyInstance;
  public isRunning = false;
  private nativeHost: NativeMessagingHost | null = null;
  private sessions: Map<
    string,
    { transport: StreamableHTTPServerTransport; server: McpServerType; lastSeen: number }
  > = new Map();
  private sseTransports: Map<string, SSEServerTransport> = new Map();
  private reaperTimer: NodeJS.Timeout | null = null;
  private agentStreamManager: AgentStreamManager;
  private agentChatService: AgentChatService;

  constructor() {
    this.fastify = Fastify({ logger: SERVER_CONFIG.LOGGER_ENABLED });
    this.agentStreamManager = new AgentStreamManager();
    this.agentChatService = new AgentChatService({
      engines: [new CodexEngine(), new ClaudeEngine()],
      streamManager: this.agentStreamManager,
    });
    this.setupPlugins();
    this.setupRoutes();
  }

  /**
   * Associate NativeMessagingHost instance.
   */
  public setNativeHost(nativeHost: NativeMessagingHost): void {
    this.nativeHost = nativeHost;
  }

  private async setupPlugins(): Promise<void> {
    await this.fastify.register(cors, {
      origin: (origin, cb) => {
        // Allow requests with no origin (e.g., curl, server-to-server)
        if (!origin) {
          return cb(null, true);
        }
        // Check if origin matches any pattern in whitelist
        const allowed = SERVER_CONFIG.CORS_ORIGIN.some((pattern) =>
          pattern instanceof RegExp ? pattern.test(origin) : origin.startsWith(pattern),
        );
        cb(null, allowed);
      },
      methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      credentials: true,
    });
  }

  private setupRoutes(): void {
    // Health check
    this.setupHealthRoutes();

    // Extension communication
    this.setupExtensionRoutes();

    // Agent routes (delegated to separate module)
    registerAgentRoutes(this.fastify, {
      streamManager: this.agentStreamManager,
      chatService: this.agentChatService,
    });

    // MCP routes
    this.setupMcpRoutes();
  }

  // ============================================================
  // Health Routes
  // ============================================================

  private setupHealthRoutes(): void {
    this.fastify.get('/ping', async (_request: FastifyRequest, reply: FastifyReply) => {
      reply.status(HTTP_STATUS.OK).send({
        status: 'ok',
        message: 'pong',
      });
    });

    this.fastify.get('/health', async (_request: FastifyRequest, reply: FastifyReply) => {
      reply.status(HTTP_STATUS.OK).send({
        status: 'ok',
        extensionConnected: this.nativeHost?.connected ?? false,
        running: this.isRunning,
        sessions: this.sessions.size,
        sseSessions: this.sseTransports.size,
        uptimeSec: Math.round(process.uptime()),
      });
    });
  }

  // ============================================================
  // Extension Routes
  // ============================================================

  private setupExtensionRoutes(): void {
    this.fastify.get(
      '/ask-extension',
      async (request: FastifyRequest<{ Body: ExtensionRequestPayload }>, reply: FastifyReply) => {
        if (!this.nativeHost) {
          return reply
            .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
            .send({ error: ERROR_MESSAGES.NATIVE_HOST_NOT_AVAILABLE });
        }
        if (!this.isRunning) {
          return reply
            .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
            .send({ error: ERROR_MESSAGES.SERVER_NOT_RUNNING });
        }

        try {
          const extensionResponse = await this.nativeHost.sendRequestToExtensionAndWait(
            request.query,
            'process_data',
            TIMEOUTS.EXTENSION_REQUEST_TIMEOUT,
          );
          return reply.status(HTTP_STATUS.OK).send({ status: 'success', data: extensionResponse });
        } catch (error: unknown) {
          const err = error as Error;
          if (err.message.includes('timed out')) {
            return reply
              .status(HTTP_STATUS.GATEWAY_TIMEOUT)
              .send({ status: 'error', message: ERROR_MESSAGES.REQUEST_TIMEOUT });
          } else {
            return reply.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send({
              status: 'error',
              message: `Failed to get response from extension: ${err.message}`,
            });
          }
        }
      },
    );
  }

  // ============================================================
  // MCP Routes
  // ============================================================

  private setupMcpRoutes(): void {
    // Loopback-only guard: reject non-local Host headers (DNS rebinding) and
    // any browser-originated request (extension pages never send Origin here).
    this.fastify.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
      const url = request.raw.url || '';
      if (!/^\/(mcp|sse|messages)(?:$|[/?])/.test(url)) return;
      const hostHeader = String(request.headers.host || '');
      const host = hostHeader.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
      if (host && !['127.0.0.1', 'localhost', '::1'].includes(host)) {
        reply.code(HTTP_STATUS.FORBIDDEN).send({ error: 'forbidden host' });
        return;
      }
      if (request.headers.origin) {
        reply.code(HTTP_STATUS.FORBIDDEN).send({ error: 'origin not allowed' });
        return;
      }
    });

    // ---- Legacy SSE transport (one Server per connection) ----
    this.fastify.get('/sse', async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        reply.raw.writeHead(HTTP_STATUS.OK, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });

        const transport = new SSEServerTransport('/messages', reply.raw);
        this.sseTransports.set(transport.sessionId, transport);

        reply.raw.on('close', () => {
          this.sseTransports.delete(transport.sessionId);
        });

        await createMcpServer().connect(transport);
        reply.raw.write(':\n\n');
      } catch {
        if (!reply.sent) {
          reply.code(HTTP_STATUS.INTERNAL_SERVER_ERROR).send(ERROR_MESSAGES.INTERNAL_SERVER_ERROR);
        }
      }
    });

    this.fastify.post('/messages', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { sessionId } = request.query as { sessionId?: string };
        const transport = this.sseTransports.get(sessionId || '');
        if (!sessionId || !transport) {
          reply.code(HTTP_STATUS.BAD_REQUEST).send('No transport found for sessionId');
          return;
        }
        await transport.handlePostMessage(request.raw, reply.raw, request.body);
      } catch {
        if (!reply.sent) {
          reply.code(HTTP_STATUS.INTERNAL_SERVER_ERROR).send(ERROR_MESSAGES.INTERNAL_SERVER_ERROR);
        }
      }
    });

    // ---- Streamable HTTP: dedicated Server instance per session ----
    this.fastify.post('/mcp', async (request: FastifyRequest, reply: FastifyReply) => {
      const sessionId = request.headers['mcp-session-id'] as string | undefined;

      if (sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session) {
          reply.code(HTTP_STATUS.NOT_FOUND).send({
            jsonrpc: '2.0',
            error: { code: -32001, message: 'MCP session not found; re-initialize' },
            id: null,
          });
          return;
        }
        session.lastSeen = Date.now();
        try {
          await session.transport.handleRequest(request.raw, reply.raw, request.body);
        } catch {
          if (!reply.sent) {
            reply
              .code(HTTP_STATUS.INTERNAL_SERVER_ERROR)
              .send({ error: ERROR_MESSAGES.MCP_REQUEST_PROCESSING_ERROR });
          }
        }
        return;
      }

      if (!isInitializeRequest(request.body)) {
        reply.code(HTTP_STATUS.BAD_REQUEST).send({ error: ERROR_MESSAGES.INVALID_MCP_REQUEST });
        return;
      }

      const newSessionId = randomUUID();
      const server = createMcpServer();
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => newSessionId,
        onsessioninitialized: (initializedSessionId: string) => {
          this.sessions.set(initializedSessionId, { transport, server, lastSeen: Date.now() });
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) {
          this.sessions.delete(transport.sessionId);
        }
      };

      await server.connect(transport);
      try {
        await transport.handleRequest(request.raw, reply.raw, request.body);
      } catch {
        if (!reply.sent) {
          reply
            .code(HTTP_STATUS.INTERNAL_SERVER_ERROR)
            .send({ error: ERROR_MESSAGES.MCP_REQUEST_PROCESSING_ERROR });
        }
      }
    });

    this.fastify.get('/mcp', async (request: FastifyRequest, reply: FastifyReply) => {
      const sessionId = request.headers['mcp-session-id'] as string | undefined;
      const session = sessionId ? this.sessions.get(sessionId) : undefined;

      if (!session) {
        reply.code(HTTP_STATUS.BAD_REQUEST).send({ error: ERROR_MESSAGES.INVALID_SSE_SESSION });
        return;
      }
      session.lastSeen = Date.now();

      reply.raw.setHeader('Content-Type', 'text/event-stream');
      reply.raw.setHeader('Cache-Control', 'no-cache');
      reply.raw.setHeader('Connection', 'keep-alive');
      reply.raw.flushHeaders();

      try {
        await session.transport.handleRequest(request.raw, reply.raw);
        if (!reply.sent) {
          reply.hijack();
        }
      } catch {
        if (!reply.raw.writableEnded) {
          reply.raw.end();
        }
      }
    });

    this.fastify.delete('/mcp', async (request: FastifyRequest, reply: FastifyReply) => {
      const sessionId = request.headers['mcp-session-id'] as string | undefined;
      const session = sessionId ? this.sessions.get(sessionId) : undefined;

      if (!session || !sessionId) {
        reply.code(HTTP_STATUS.BAD_REQUEST).send({ error: ERROR_MESSAGES.INVALID_SESSION_ID });
        return;
      }

      try {
        await session.transport.handleRequest(request.raw, reply.raw);
      } catch {
        // teardown is best-effort
      }
      await this.closeSession(sessionId, session);
      if (!reply.sent) {
        reply.code(HTTP_STATUS.NO_CONTENT).send();
      }
    });
  }

  private async closeSession(
    sessionId: string,
    session: { transport: StreamableHTTPServerTransport; server: McpServerType; lastSeen: number },
  ): Promise<void> {
    this.sessions.delete(sessionId);
    try {
      await session.transport.close();
    } catch {
      // ignore
    }
    try {
      await session.server.close();
    } catch {
      // ignore
    }
  }

  /** Reap sessions untouched for ttlMs (client crashed without DELETE). */
  private async reapSessions(ttlMs: number): Promise<void> {
    const now = Date.now();
    for (const [id, session] of [...this.sessions.entries()]) {
      if (now - session.lastSeen <= ttlMs) continue;
      await this.closeSession(id, session);
      console.log('[mcp] reaped idle session', id);
    }
  }

  // ============================================================
  // Server Lifecycle
  // ============================================================

  public async start(port = NATIVE_SERVER_PORT, nativeHost: NativeMessagingHost): Promise<void> {
    if (!this.nativeHost) {
      this.nativeHost = nativeHost;
    } else if (this.nativeHost !== nativeHost) {
      this.nativeHost = nativeHost;
    }

    if (this.isRunning) {
      return;
    }

    try {
      await this.fastify.listen({ port, host: SERVER_CONFIG.HOST });

      // Set port environment variables after successful listen for Chrome MCP URL resolution
      process.env.CHROME_MCP_PORT = String(port);
      process.env.MCP_HTTP_PORT = String(port);

      this.isRunning = true;

      if (!this.reaperTimer) {
        this.reaperTimer = setInterval(() => {
          void this.reapSessions(MCP_SESSION_TTL_MS);
        }, MCP_REAP_INTERVAL_MS);
        this.reaperTimer.unref?.();
      }
    } catch (err) {
      this.isRunning = false;
      throw err;
    }
  }

  public async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    try {
      if (this.reaperTimer) {
        clearInterval(this.reaperTimer);
        this.reaperTimer = null;
      }
      for (const [id, session] of [...this.sessions.entries()]) {
        await this.closeSession(id, session);
      }
      await this.fastify.close();
      closeDb();
      this.isRunning = false;
    } catch (err) {
      this.isRunning = false;
      closeDb();
      throw err;
    }
  }

  public getInstance(): FastifyInstance {
    return this.fastify;
  }
}

const MCP_SESSION_TTL_MS = 30 * 60 * 1000;
const MCP_REAP_INTERVAL_MS = 30 * 1000;

const serverInstance = new Server();
export default serverInstance;
