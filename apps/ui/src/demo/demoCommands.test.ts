import { describe, expect, it, vi } from 'vitest';
import { makeDemoCommands } from './demoCommands';

describe('makeDemoCommands', () => {
  it('routes stop to exit — never a runner command', async () => {
    const exit = vi.fn();
    const resolve = vi.fn();
    const reject = vi.fn();
    const commands = makeDemoCommands({ exit, resolve, reject });
    await commands.stop('run_bme280_001');
    expect(exit).toHaveBeenCalledTimes(1);
    expect(resolve).not.toHaveBeenCalled();
    expect(reject).not.toHaveBeenCalled();
  });

  it('routes an approval to the recording fast-forward, passing the approval id', async () => {
    const exit = vi.fn();
    const resolve = vi.fn();
    const reject = vi.fn();
    const commands = makeDemoCommands({ exit, resolve, reject });
    await commands.resolveApproval('run_bme280_001', 'apr_flash_iter1', 'approved');
    expect(resolve).toHaveBeenCalledWith('apr_flash_iter1');
    expect(exit).not.toHaveBeenCalled();
    expect(reject).not.toHaveBeenCalled();
  });

  it('routes a rejection to the honest reject notice — never a fast-forward (F1)', async () => {
    const exit = vi.fn();
    const resolve = vi.fn();
    const reject = vi.fn();
    const commands = makeDemoCommands({ exit, resolve, reject });
    await commands.resolveApproval('run_bme280_001', 'apr_flash_iter1', 'rejected');
    // The recording was approved: rejecting must NOT continue playback (no resolve),
    // and must not silently exit either — it hands off to the notice.
    expect(reject).toHaveBeenCalledTimes(1);
    expect(resolve).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });
});
