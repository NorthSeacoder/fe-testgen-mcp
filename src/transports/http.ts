import express, { type Express, type Request, type Response } from 'express';
import cors from 'cors';
import { ToolRegistry } from '../core/tool-registry.js';
import { logger } from '../utils/logger.js';
import { getMetrics } from '../utils/metrics.js';
import { getPrometheusExporter } from '../utils/prometheus-exporter.js';

export interface HttpTransportOptions {
  port?: number;
  host?: string;
  cors?: cors.CorsOptions;
}

export class HttpTransport {
  private app: Express;
  private server?: ReturnType<Express['listen']>;

  constructor(
    private toolRegistry: ToolRegistry,
    private options: HttpTransportOptions = {}
  ) {
    this.app = express();
    this.app.use(express.json({ limit: '2mb' }));
    this.app.use(cors(this.options.cors || {}));

    this.registerRoutes();
  }

  async start(): Promise<void> {
    const port = this.options.port ?? 3000;
    const host = this.options.host ?? '0.0.0.0';

    await new Promise<void>((resolve) => {
      this.server = this.app.listen(port, host, () => {
        logger.info(`[HttpTransport] Listening on http://${host}:${port}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve, reject) => {
        this.server?.close((error?: Error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    }
  }

  private registerRoutes(): void {
    this.app.get('/api/tools', async (_req: Request, res: Response) => {
      const tools = this.toolRegistry.listMetadata();
      res.json({ tools });
    });

    this.app.post('/api/tools/call', async (req: Request, res: Response): Promise<void> => {
      const { name, arguments: args } = req.body;
      if (!name) {
        res.status(400).json({ error: 'Tool name is required' });
        return;
      }

      try {
        const tool = await this.toolRegistry.get(name);
        if (!tool) {
          res.status(404).json({ error: `Tool '${name}' not found` });
          return;
        }

        getMetrics().recordCounter('http.tool.called', 1, { tool: name });
        const result = await tool.execute(args || {});
        res.json(result);
      } catch (error) {
        logger.error('[HttpTransport] Tool execution failed', { error });
        res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
      }
    });

    this.app.get('/api/metrics', async (_req: Request, res: Response) => {
      try {
        const exporter = getPrometheusExporter();
        const metrics = await exporter.export();
        res.type('text/plain').send(metrics);
      } catch (error) {
        logger.error('[HttpTransport] Failed to export metrics', { error });
        res.status(500).json({ error: 'Failed to export metrics' });
      }
    });

    this.app.get('/api/health', (_req: Request, res: Response) => {
      res.json({ status: 'ok', timestamp: Date.now() });
    });
  }
}
