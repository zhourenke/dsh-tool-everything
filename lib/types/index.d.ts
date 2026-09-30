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
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess';
import type { PromptSection } from '@deepseek-ai/dsh-system-prompt';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
/** Plugin configuration after schemastery defaulting (fields stay optional so the coalescing below is honest). */
interface EverythingConfig {
    timeoutMs?: number;
    countTimeoutMs?: number;
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
    /** The host's own `ToolDefinition`, so a tool shape that drifts fails `tsc`. */
    tools: {
        register(definition: ToolDefinition): unknown;
    };
    subprocess: {
        spawn(spec: SubprocessSpawnSpec): SubprocessHandle;
    };
    /**
     * Ambient host logger. Optional because nothing in this plugin's contract
     * requires it: the one warning it carries (a count pass that yielded no total)
     * is diagnostics, so a host without it must still run the tool.
     */
    logger?: {
        warn(message: string): unknown;
    };
}
/** Cordis plugin name used by loader diagnostics. */
declare const name = "tool-everything";
/** Services required by the tool. */
declare const inject: string[];
/**
 * Plugin configuration schema.
 *
 * The `as unknown as ReturnType<typeof z.any>` widening keeps this exported
 * declaration portable, and the three forms were measured rather than guessed:
 *
 * - Exporting the schema as-is (`const Config = configSchema`) is the form to
 *   try first. It compiles while this package and the host resolve the SAME
 *   schemastery copy (measured after pinning `~3.18.4`, the line every DSH
 *   0.2.0-rc.2 package declares), and it goes red the moment the two copies
 *   split (`TS2883: The inferred type of 'Config' cannot be named without a
 *   reference to 'Schema'`) — which is a signal to re-decide, not a bug.
 * - Annotating it directly fails either way: `Schema`'s `data` parameter is
 *   contravariant, so `Schema<ObjectS<…>>` is not assignable to
 *   `Schema<unknown, unknown, 'plain'>` (`TS2322`).
 * - Widening through the double assertion always compiles, at the cost of not
 *   checking the export at all.
 *
 * The assertion is kept because the split is something the host can cause on
 * its own schedule (a DSH upgrade to a new schemastery line), and the emitted
 * declaration then stays portable instead of turning a dependency bump into a
 * build break. PLUGIN_RELEASE_GUIDE.md 「DSH 升级后的复核」 greps for exactly
 * this expression, so do not delete it as a redundant cast.
 * @see PLUGIN_RELEASE_GUIDE.md 「类型定义原则」
 */
declare const Config: ReturnType<typeof z.any>;
/**
 * Register the `everything_search` tool.
 */
declare function apply(ctx: HostContext, config: EverythingConfig): void;
export { apply, Config, inject, name };
