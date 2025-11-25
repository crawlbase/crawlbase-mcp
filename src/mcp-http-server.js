#!/usr/bin/env node

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { toReqRes, toFetchResponse } from 'fetch-to-node';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CrawlbaseMCPServer } from './mcp-server.js';
import { debug, isDebugEnabled, getDebugFilePath } from './utils/debug.js';

const PORT = process.env.MCP_PORT || 3000;

if (isDebugEnabled()) {
  debug('=== Starting Crawlbase MCP HTTP Server ===');
  debug('Debug log location:', getDebugFilePath());
}

// Shared server instance for requests without header tokens (uses env vars)
const sharedMcpServer = new CrawlbaseMCPServer();
const app = new Hono();

app.post('/mcp', async (c) => {
  debug('Received HTTP request to /mcp');

  try {
    // Extract tokens from headers
    const headerToken = c.req.header('X-Crawlbase-Token');
    const headerJsToken = c.req.header('X-Crawlbase-JS-Token');

    // Use per-request server if headers provided, otherwise shared instance
    const mcpServer =
      headerToken || headerJsToken
        ? new CrawlbaseMCPServer({ token: headerToken, jsToken: headerJsToken })
        : sharedMcpServer;

    debug('Using tokens from:', headerToken || headerJsToken ? 'HTTP headers' : 'environment variables');

    const { req, res } = toReqRes(c.req.raw);
    const body = await c.req.json();

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // Stateless mode
    });

    res.on('close', () => {
      debug('HTTP connection closed, cleaning up transport');
      transport.close();
    });

    await mcpServer.server.connect(transport);
    await transport.handleRequest(req, res, body);

    return toFetchResponse(res);
  } catch (error) {
    debug('Error handling MCP request:', error);
    return c.json(
      {
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: error.message || 'Internal server error',
        },
        id: null,
      },
      500,
    );
  }
});

app.get('/health', (c) => c.json({ status: 'ok' }));

console.log(`Crawlbase MCP HTTP server running at http://localhost:${PORT}/mcp`);

serve({
  fetch: app.fetch,
  port: Number(PORT),
});
