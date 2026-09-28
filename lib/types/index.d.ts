/**
 * @zhourenke/dsh-tool-everything
 *
 * A model-facing Everything search tool powered by the `es` command-line client
 * (es.exe). Provides blazing-fast file search on Windows via the Everything
 * search engine, supporting the full Everything search syntax (wildcards, regex,
 * size:, dm:, etc.).
 *
 * @module @zhourenke/dsh-tool-everything
 */
import z from '@deepseek-ai/schemastery';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess';
import type { PromptSection } from '@deepseek-ai/dsh-system-prompt';
/** Default max results to return. */
declare const DEFAULT_MAX_RESULTS = 50;
/** Maximum allowed max_results (safety cap). */
declare const ABSOLUTE_MAX_RESULTS = 100000;
/** Default cooperative tool-call timeout budget in milliseconds. */
declare const DEFAULT_TIMEOUT_MS = 1200000;
/** Default terminate grace period for the `es` process (ms). */
declare const DEFAULT_GRACE_MS = 3000;
/** Default cap in bytes on the retained stderr tail. */
declare const DEFAULT_STDERR_MAX_BYTES: number;
/** Default cap in bytes on the raw stdout the tool will parse. */
declare const DEFAULT_RAW_OUTPUT_MAX_BYTES = 20000000;
/** Error codes for `everything_search` failures. */
type EverythingErrorCode = 'ES_NOT_FOUND' | 'ES_FAILED' | 'ES_RAW_OUTPUT_OVERFLOW' | 'ES_ABORTED';
/** Typed search failure extending HarnessError. */
declare class EverythingError extends HarnessError {
    code: EverythingErrorCode;
    constructor(message: string, code: EverythingErrorCode, options?: ErrorOptions);
}
/** Plugin configuration after schemastery defaulting (fields stay optional so the coalescing below is honest). */
interface EverythingConfig {
    timeoutMs?: number;
    graceMs?: number;
    stderrMaxBytes?: number;
    rawOutputMaxBytes?: number;
}
/** The host services this plugin consumes. */
interface HostContext {
    systemPrompt: {
        section(section: PromptSection): unknown;
        /** Central placement of a registered section, or undefined for an unknown name. */
        getSectionOrder(name: string): number | undefined;
    };
    tools: {
        register(definition: {
            name: string;
        }): unknown;
    };
    subprocess: {
        spawn(spec: SubprocessSpawnSpec): SubprocessHandle;
    };
}
/** Cordis plugin name used by loader diagnostics. */
declare const name = "tool-everything";
/** Services required by the tool. */
declare const inject: string[];
/**
 * Plugin configuration schema.
 *
 * The `as unknown as ReturnType<typeof z.any>` widening is required, not
 * cosmetic: schemastery 3.18.4 (the copy DSH 0.1.7-rc.2 resolves for us) makes
 * the inferred type of `z.object({...})` unnameable from an exported declaration
 * (`TS2883: The inferred type of 'Config' cannot be named without a reference to
 * 'Schema'`), while annotating it directly fails on `Schema`'s variance
 * (`TS2322`). Erasing to the default export's return type keeps the declaration
 * portable, and matches the other plugins in this workspace.
 * @see PLUGIN_RELEASE_GUIDE.md 「类型定义原则」
 */
declare const Config: ReturnType<typeof z.any>;
/**
 * Register the `everything_search` tool.
 */
declare function apply(ctx: HostContext, config: EverythingConfig): Promise<void>;
export { apply, Config, inject, name };
export { EverythingError, DEFAULT_MAX_RESULTS, ABSOLUTE_MAX_RESULTS, DEFAULT_TIMEOUT_MS, DEFAULT_GRACE_MS, DEFAULT_STDERR_MAX_BYTES, DEFAULT_RAW_OUTPUT_MAX_BYTES, };
