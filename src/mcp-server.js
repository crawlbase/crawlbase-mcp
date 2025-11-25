#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { CrawlbaseClient, CrawlbaseParametersSchema } from './crawlbase/index.js';
import { MarkdownExtractor } from './utils/markdown.js';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';
import { debug, isDebugEnabled, getDebugFilePath } from './utils/debug.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));

class CrawlbaseMCPServer {
  constructor() {
    debug('=== CrawlbaseMCPServer Starting ===');
    debug('Environment:', {
      nodeVersion: process.version,
      platform: process.platform,
      cwd: process.cwd(),
    });

    this.server = new Server(
      { name: 'crawlbase-mcp-server', version: packageJson.version },
      { capabilities: { tools: {} } },
    );

    if (!process.env.CRAWLBASE_TOKEN && !process.env.CRAWLBASE_JS_TOKEN) {
      debug(
        'Warning: No Crawlbase tokens provided. Please set CRAWLBASE_TOKEN and/or CRAWLBASE_JS_TOKEN environment variables.',
      );
    }

    this.client = new CrawlbaseClient(process.env.CRAWLBASE_TOKEN, process.env.CRAWLBASE_JS_TOKEN);
    debug('CrawlbaseClient initialized with tokens:', {
      hasNormalToken: !!process.env.CRAWLBASE_TOKEN,
      hasJsToken: !!process.env.CRAWLBASE_JS_TOKEN,
      tokenLengths: {
        normal: process.env.CRAWLBASE_TOKEN?.length || 0,
        js: process.env.CRAWLBASE_JS_TOKEN?.length || 0,
      },
    });

    this.markdownExtractor = new MarkdownExtractor();
    this.setupHandlers();
    debug('Constructor completed');
  }

  setupHandlers() {
    debug('Setting up request handlers');

    this.server.setRequestHandler(ListToolsRequestSchema, () => {
      debug('Received ListTools request');
      const response = {
        tools: [
          {
            name: 'crawl',
            description: 'Crawl a URL and return HTML content',
            inputSchema: {
              type: 'object',
              properties: {
                url: {
                  type: 'string',
                  description: 'The URL to crawl',
                },
                user_agent: {
                  type: 'string',
                  description: 'Custom user agent string',
                },
                device: {
                  type: 'string',
                  enum: ['desktop', 'mobile', 'tablet'],
                  description: 'Device type for crawling',
                },
                country: {
                  type: 'string',
                  description: 'Country code for geo-targeting',
                },
                ajax_wait: {
                  type: 'number',
                  description: 'Wait time for AJAX requests in milliseconds',
                },
                page_wait: {
                  type: 'number',
                  description: 'Wait time for page load in milliseconds',
                },
                screenshot: {
                  type: 'boolean',
                  description: 'Take a screenshot of the page',
                },
              },
              required: ['url'],
            },
          },
          {
            name: 'crawl_markdown',
            description: 'Crawl a URL and extract clean markdown content',
            inputSchema: {
              type: 'object',
              properties: {
                url: {
                  type: 'string',
                  description: 'The URL to crawl',
                },
                user_agent: {
                  type: 'string',
                  description: 'Custom user agent string',
                },
                device: {
                  type: 'string',
                  enum: ['desktop', 'mobile', 'tablet'],
                  description: 'Device type for crawling',
                },
              },
              required: ['url'],
            },
          },
          {
            name: 'crawl_screenshot',
            description: 'Take a screenshot of a webpage',
            inputSchema: {
              type: 'object',
              properties: {
                url: {
                  type: 'string',
                  description: 'The URL to screenshot',
                },
                device: {
                  type: 'string',
                  enum: ['desktop', 'mobile', 'tablet'],
                  description: 'Device type for screenshot',
                },
                page_wait: {
                  type: 'number',
                  description: 'Wait time before taking screenshot',
                },
                mode: {
                  type: 'string',
                  enum: ['fullpage', 'viewport'],
                  description: 'Screenshot mode (default: fullpage)',
                },
                width: {
                  type: 'number',
                  description: 'Maximum width in pixels (only with mode=viewport)',
                },
                height: {
                  type: 'number',
                  description: 'Maximum height in pixels (only with mode=viewport)',
                },
              },
              required: ['url'],
            },
          },
        ],
      };
      debug('Returning tools list with', response.tools.length, 'tools');
      return response;
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      debug('Received CallTool request:', { tool: name, args });

      try {
        switch (name) {
          case 'crawl':
            return await this.handleCrawl(args);
          case 'crawl_markdown':
            return await this.handleCrawlMarkdown(args);
          case 'crawl_screenshot':
            return await this.handleCrawlScreenshot(args);
          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error) {
        debug('Error in CallTool handler:', error);
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    });
  }

  async handleCrawl(args) {
    debug('handleCrawl called with:', args);
    const params = CrawlbaseParametersSchema.parse(args);
    debug('Parsed parameters:', params);

    const result = await this.client.crawl(params);
    debug('Crawl result:', {
      success: result.success,
      hasBody: !!result.data?.body,
      bodyLength: result.data?.body?.length,
      error: result.error,
    });
    if (result.success) {
      return {
        content: [
          {
            type: 'text',
            text: `Successfully crawled ${params.url}\n\nHTML Content:\n${result.data.body}`,
          },
        ],
      };
    } else {
      return {
        content: [
          {
            type: 'text',
            text: `Failed to crawl ${params.url}: ${result.error.error}`,
          },
        ],
        isError: true,
      };
    }
  }

  async handleCrawlMarkdown(args) {
    const params = CrawlbaseParametersSchema.parse(args);
    const result = await this.client.crawl(params);
    if (result.success) {
      const markdown = this.markdownExtractor.extractMarkdown(result.data.body, params.url);

      // Limit content size to stay under token limits
      const maxLength = 50000; // Characters, not tokens, but safe estimate
      let content = markdown.content;

      if (content.length > maxLength) {
        content = content.substring(0, maxLength) + '\n\n[Content truncated due to size limits]';
      }

      return {
        content: [
          {
            type: 'text',
            text: `# ${markdown.title}\n\n${markdown.excerpt ? `**Summary:** ${markdown.excerpt}\n\n` : ''}${content}`,
          },
        ],
      };
    } else {
      return {
        content: [
          {
            type: 'text',
            text: `Failed to crawl ${params.url}: ${result.error.error}`,
          },
        ],
        isError: true,
      };
    }
  }

  async handleCrawlScreenshot(args) {
    if (!this.client.jsToken) {
      return {
        content: [
          {
            type: 'text',
            text: `Failed to take screenshot: JavaScript token (CRAWLBASE_JS_TOKEN) is required for screenshots but not configured.`,
          },
        ],
        isError: true,
      };
    }

    // Force use of JS token for screenshots
    const params = CrawlbaseParametersSchema.parse({
      ...args,
      screenshot: true,
      token: this.client.jsToken,
    });
    debug('Screenshot request params:', params);

    const result = await this.client.crawl(params);
    debug('Screenshot crawl result:', {
      success: result.success,
      hasScreenshotUrl: !!result.data?.screenshot_url,
      screenshotUrl: result.data?.screenshot_url,
      error: result.error,
    });
    if (result.success) {
      // Check if screenshot_url is provided in the response
      if (result.data.screenshot_url) {
        try {
          // Download the screenshot from the provided URL
          const screenshotResponse = await fetch(result.data.screenshot_url);
          if (screenshotResponse.ok) {
            const screenshotBuffer = await screenshotResponse.arrayBuffer();
            let imageBuffer = Buffer.from(screenshotBuffer);

            // Check image dimensions and resize if needed
            const MAX_DIMENSION = 8000;
            const metadata = await sharp(imageBuffer).metadata();

            if (metadata.width > MAX_DIMENSION || metadata.height > MAX_DIMENSION) {
              // Resize the image to fit within max dimensions while maintaining aspect ratio
              imageBuffer = await sharp(imageBuffer)
                .resize(MAX_DIMENSION, MAX_DIMENSION, { fit: 'inside', withoutEnlargement: true })
                .jpeg({ quality: 80 })
                .toBuffer();
            }

            const screenshotBase64 = imageBuffer.toString('base64');

            return {
              content: [
                { type: 'image', data: screenshotBase64, mimeType: 'image/jpeg' },
                {
                  type: 'text',
                  text: `Screenshot successfully taken of ${params.url}\n\nScreenshot URL: ${result.data.screenshot_url}`,
                },
              ],
            };
          } else {
            return {
              content: [
                {
                  type: 'text',
                  text: `Screenshot was generated for ${params.url}, but failed to download from URL: ${result.data.screenshot_url}. Status: ${screenshotResponse.status}`,
                },
              ],
              isError: true,
            };
          }
        } catch (error) {
          return {
            content: [
              {
                type: 'text',
                text: `Screenshot was generated for ${params.url}, but failed to download from URL: ${result.data.screenshot_url}. Error: ${error.message}`,
              },
            ],
            isError: true,
          };
        }
      } else {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to take screenshot of ${params.url}: No screenshot URL returned. Please ensure you have a valid JavaScript token configured.`,
            },
          ],
          isError: true,
        };
      }
    } else {
      return {
        content: [
          {
            type: 'text',
            text: `Failed to take screenshot of ${params.url}: ${result.error?.error || 'Unknown error'}`,
          },
        ],
        isError: true,
      };
    }
  }

  async run() {
    debug('Starting MCP server run()');
    const transport = new StdioServerTransport();
    debug('Created StdioServerTransport');

    await this.server.connect(transport);
    debug('Server connected and ready for requests');
  }
}

export { CrawlbaseMCPServer };

// Auto-run only when executed directly (stdio mode)
const isDirectExecution =
  import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('crawlbase-mcp.js');

if (isDirectExecution) {
  if (isDebugEnabled()) {
    debug('=== Starting Crawlbase MCP Server ===');
    debug('Debug log location:', getDebugFilePath());
    debug('Debug mode enabled via DEBUG environment variable');
  }

  const server = new CrawlbaseMCPServer();
  server.run().catch((error) => {
    debug('Fatal error:', error);
    process.exit(1);
  });
}
