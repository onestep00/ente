import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import log from "../log-worker";

/**
 * Run a shell command asynchronously (utility process edition).
 *
 * This is an almost verbatim copy of {@link execAsync} from `electron.ts`,
 * except it is meant to be usable from a utility process where only a subset of
 * imports are available. See [Note: Using Electron APIs in UtilityProcess].
 */
export const execAsyncWorker = async (command: string | string[]) => {
    const startTime = Date.now();
    if (Array.isArray(command)) {
        const [binary, ...args] = command;
        if (!binary) throw new Error("Command missing executable");
        const result = await execFileAsync(binary, args, {
            windowsHide: true,
            maxBuffer: 16 * 1024 * 1024,
        });
        log.debugString(
            `${[binary, ...args].join(" ")} (${Date.now() - startTime} ms)`,
        );
        return result;
    }
    const result = await execAsync_(command);
    log.debugString(`${command} (${Date.now() - startTime} ms)`);
    return result;
};

const execAsync_ = promisify(exec);
const execFileAsync = promisify(execFile);
