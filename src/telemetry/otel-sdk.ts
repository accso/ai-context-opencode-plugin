import { randomUUID } from "node:crypto";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import type { PushMetricExporter } from "@opentelemetry/sdk-metrics";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import type { OtelMeterLike } from "./telemetry.js";

/**
 * Opt-in OTLP metrics export (default off). Deliberately NOT registered as the
 * global MeterProvider: the host's own OTel setup stays untouched; the provider's
 * meter is handed to `createTelemetryRecorder` explicitly. See ADR-0011.
 */

export const DEFAULT_OTEL_ENDPOINT = "http://127.0.0.1:4318";
export const DEFAULT_OTEL_FLUSH_MS = 5000;

export interface OtelSettings {
  enabled: boolean;
  endpoint: string;
  flushMs: number;
  project: string;
  /** Add `sessionID` as a metric attribute (high cardinality). */
  includeSessionId: boolean;
}

export interface OtelFileConfig {
  otelEnabled?: boolean;
  otelEndpoint?: string;
  otelFlushMs?: number;
  project?: string;
}

const isTrue = (v: string | undefined) => v !== undefined && !["", "0", "false"].includes(v.toLowerCase());

/** env > config file > default. */
export function resolveOtelSettings(
  fallbackProject: string,
  file: OtelFileConfig = {},
  env: NodeJS.ProcessEnv = process.env,
): OtelSettings {
  const flush = Number(env.AI_CONTEXT_OTEL_FLUSH_MS);
  return {
    enabled: env.AI_CONTEXT_OTEL_ENABLED !== undefined ? isTrue(env.AI_CONTEXT_OTEL_ENABLED) : file.otelEnabled === true,
    endpoint: env.AI_CONTEXT_OTEL_ENDPOINT || file.otelEndpoint || DEFAULT_OTEL_ENDPOINT,
    flushMs: Number.isFinite(flush) && flush > 0 ? flush : (file.otelFlushMs ?? DEFAULT_OTEL_FLUSH_MS),
    project: env.AI_CONTEXT_PROJECT || file.project || fallbackProject,
    includeSessionId: isTrue(env.AI_CONTEXT_OTEL_SESSION_ID),
  };
}

export interface OtelMetricsHandle {
  meter: OtelMeterLike;
  shutdown(): Promise<void>;
}

export interface InitOtelOptions {
  endpoint?: string;
  flushMs?: number;
  project: string;
  /** Test injection; defaults to an OTLP/HTTP exporter at `<endpoint>/v1/metrics`. */
  exporter?: PushMetricExporter;
  onWarn?: (message: string) => void;
}

export function initOtelMetrics(options: InitOtelOptions): OtelMetricsHandle {
  const endpoint = (options.endpoint ?? DEFAULT_OTEL_ENDPOINT).replace(/\/+$/, "");
  const warn = options.onWarn ?? ((m: string) => console.error(`[ai-context] ${m}`));
  let warned = false;
  const exporter: PushMetricExporter =
    options.exporter ?? new OTLPMetricExporter({ url: `${endpoint}/v1/metrics`, timeoutMillis: 3000 });

  // Wrap the export so a down collector yields one warning, never an error.
  const safeExporter: PushMetricExporter = {
    export(metrics, done) {
      try {
        exporter.export(metrics, (result) => {
          if (result.code !== 0 && !warned) {
            warned = true;
            warn(`OTLP metrics export to ${endpoint} failed: ${result.error?.message ?? "unknown error"}`);
          }
          done({ code: 0 });
        });
      } catch (error) {
        if (!warned) {
          warned = true;
          warn(`OTLP metrics export failed: ${(error as Error).message}`);
        }
        done({ code: 0 });
      }
    },
    forceFlush: () => exporter.forceFlush(),
    shutdown: () => exporter.shutdown(),
    ...(exporter.selectAggregationTemporality
      ? { selectAggregationTemporality: exporter.selectAggregationTemporality.bind(exporter) }
      : {}),
    ...(exporter.selectAggregation ? { selectAggregation: exporter.selectAggregation.bind(exporter) } : {}),
  };

  const provider = new MeterProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: "ai-context",
      "service.instance.id": randomUUID(),
      project: options.project,
    }),
    readers: [
      new PeriodicExportingMetricReader({
        exporter: safeExporter,
        exportIntervalMillis: options.flushMs ?? DEFAULT_OTEL_FLUSH_MS,
        exportTimeoutMillis: Math.min(options.flushMs ?? DEFAULT_OTEL_FLUSH_MS, 3000),
      }),
    ],
  });

  return {
    meter: provider.getMeter("ai-context-opencode-plugin") as unknown as OtelMeterLike,
    async shutdown() {
      try {
        await provider.shutdown();
      } catch {
        /* collector down: never fail on exit */
      }
    },
  };
}
