import { describe, expect, it, vi } from 'vitest';
import { makeDemoCommands } from './demoCommands';

describe('makeDemoCommands', () => {
  it('routes stop to exit — never a runner command', async () => {
    const exit = vi.fn();
    const resolve = vi.fn();
    const commands = makeDemoCommands({ exit, resolve });
    await commands.stop('run_bme280_001');
    expect(exit).toHaveBeenCalledTimes(1);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('routes resolve-approval to the recording fast-forward, passing the approval id', async () => {
    const exit = vi.fn();
    const resolve = vi.fn();
    const commands = makeDemoCommands({ exit, resolve });
    await commands.resolveApproval('run_bme280_001', 'apr_flash_iter1', 'approved');
    expect(resolve).toHaveBeenCalledWith('apr_flash_iter1');
    expect(exit).not.toHaveBeenCalled();
  });
});
