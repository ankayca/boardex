// Board Profile Builder round-trip against a live mock runner (BIBLE §7.5 "done when":
// a profile created here is selectable in the composer and its checklist renders in the
// pre-run confirm). Real HTTP + WebSocket end to end; only the runner URL is stubbed.
//
// Two acts, because of one mock-runner property: POST /runs replays the canned BME280
// story and does NOT substitute the request's boardProfileId (§5.6), so the run under
// test always references the fixture's profile, bp_nucleo_f303re. Act 1 therefore
// proves a newly created profile round-trips and is selectable in the composer; act 2
// drives the same builder over the profile the run actually references and proves the
// checklist authored there is the checklist that gates Approve Plan.
//
// Everything that reads lib/config (App → pages → api) is imported dynamically AFTER
// the runner is up and VITE_RUNNER_URL is stubbed, so the api singleton binds to the
// ephemeral port.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { WebSocket } from 'ws';
import { createMockRunner, type MockRunner } from '@boardex/mock-runner';
import type { ComponentType } from 'react';

const PROBE_ID = 'pyocd:stlink:066EFF383733554157254923';

let runner: MockRunner;
let App: ComponentType;
const hadWebSocket = 'WebSocket' in globalThis;

beforeAll(async () => {
  runner = await createMockRunner({ port: 0, speed: 200 });
  vi.stubEnv('VITE_RUNNER_URL', runner.url);
  (globalThis as Record<string, unknown>).WebSocket = WebSocket;
  App = (await import('../../App')).default;
});

afterAll(async () => {
  await runner.close();
  vi.unstubAllEnvs();
  if (!hadWebSocket) delete (globalThis as Record<string, unknown>).WebSocket;
});

function renderApp(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

let user: ReturnType<typeof userEvent.setup>;

async function fill(label: string, value: string) {
  const field = screen.getByLabelText(label);
  await user.clear(field);
  await user.type(field, value);
}

const connectionRows = () => screen.getAllByRole('listitem', { name: /^Connection \d+$/ });

describe('board profile builder → composer (integration)', () => {
  it('creates a profile, then gates the plan on the checklist authored in the builder', async () => {
    // --- act 1: create a profile through the form, POST /board-profiles ----------
    user = userEvent.setup();
    renderApp('/boards/new');
    await screen.findByRole('button', { name: 'Create Profile' });

    await fill('Name', 'Blue Pill F103');
    await fill('MCU', 'STM32F103C8 (Cortex-M3)');
    await fill('Repo path', '/bench/firmware/bluepill');
    await fill('Build command', 'make');
    await fill('Flash command', 'pyocd flash --target stm32f103c8 fw.elf');
    await fill('Reset command', 'pyocd reset --target stm32f103c8');
    await fill('Port', '/dev/ttyUSB0');
    await fill('Baud', '9600');
    await fill('Max iterations', '2');
    await fill('Power note', 'Manual power: 3V3 from the ST-Link.');

    // The detected-device picker binds the probe to the bench's stable device id (§4).
    const picker = await screen.findByRole('combobox', { name: 'Detected debug probes' });
    await user.selectOptions(picker, PROBE_ID);
    expect(screen.getByLabelText('Debug probe')).toHaveValue(PROBE_ID);

    // Validate Profile reads GET /bench: the picked probe is found, and this board
    // claims no logic analyzer, so there is nothing else to resolve.
    await user.click(screen.getByRole('button', { name: 'Validate Profile' }));
    const panel = await screen.findByRole('status', { name: 'Bench validation' });
    expect(panel).toHaveTextContent('Validated — every referenced instrument is on the bench');
    expect(within(panel).getByText(PROBE_ID)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Add connection' }));
    const row = connectionRows()[0] as HTMLElement;
    await user.type(within(row).getByLabelText('Label'), 'BOOT0');
    await user.type(within(row).getByLabelText('Detail'), 'BOOT0 strapped low');

    await user.click(screen.getByRole('button', { name: 'Create Profile' }));

    // Saved: the runner echoed it back and /boards lists it.
    const list = await screen.findByRole('list', { name: 'Board profiles' });
    expect(list).toHaveTextContent('Blue Pill F103');
    expect(list).toHaveTextContent('STM32F103C8 (Cortex-M3)');
    cleanup();

    // --- act 2: edit the profile the fixture's run references --------------------
    renderApp('/boards/bp_nucleo_f303re');
    expect(await screen.findByLabelText('Name')).toHaveValue('Nucleo-F303RE');

    // Collapse the canned six-line checklist to one distinctive line, so the pre-run
    // gate can only be rendering what this form saved.
    while (connectionRows().length > 1) {
      const last = connectionRows().at(-1) as HTMLElement;
      await user.click(within(last).getByRole('button', { name: 'Remove' }));
    }
    const kept = connectionRows()[0] as HTMLElement;
    await user.clear(within(kept).getByLabelText('Label'));
    await user.type(within(kept).getByLabelText('Label'), 'SDO — GND (verify strap)');

    await user.click(screen.getByRole('button', { name: 'Save Profile' }));
    await screen.findByRole('list', { name: 'Board profiles' });
    cleanup();

    // --- act 3: drive the composer with it --------------------------------------
    renderApp('/runs/new');
    const textarea = await screen.findByRole('textbox', { name: 'Ask Boardex' });

    // Both profiles are selectable: the one created in act 1, and the one the run uses.
    await screen.findByRole('option', { name: 'Blue Pill F103' }, { timeout: 10000 });
    const selector = screen.getByRole('combobox', { name: /Board profile/ });
    await user.selectOptions(selector, 'bp_nucleo_f303re');

    await user.click(textarea);
    await user.paste('Bring up the BME280 sensor over I2C and verify readings.');
    await user.click(screen.getByRole('button', { name: 'Create Run Plan' }));

    // The plan arrives and the D12 gate renders the checklist saved in act 2 — one
    // line, its label — and holds Approve Plan closed until it is confirmed.
    const approve = await screen.findByRole('button', { name: 'Approve Plan' }, { timeout: 20000 });
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes).toHaveLength(1);
    expect(screen.getByText('SDO — GND (verify strap)')).toBeInTheDocument();
    expect(approve).toBeDisabled();

    await user.click(boxes[0] as HTMLElement);
    await waitFor(() => expect(approve).toBeEnabled());
  }, 120000);
});
