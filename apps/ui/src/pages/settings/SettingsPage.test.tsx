// Settings page (T6.6): runner-URL persistence + precedence surfaced through the UI,
// Test Connection against a mocked /health (online/offline), and the model info list.
// The api seam is mocked — api.getHealth backs the Model section; createApiClient backs
// the Test Connection probe so a candidate URL is tested without a real runner.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { HealthResponse } from '@boardex/contract';

const getHealth = vi.fn<() => Promise<HealthResponse>>();
const probeHealth = vi.fn<() => Promise<HealthResponse>>();
const createApiClientSpy = vi.fn((base: string) => {
  void base; // captured by the spy for the candidate-URL assertion; probe result is fixed
  return { getHealth: () => probeHealth() };
});

vi.mock('../../lib/api', () => ({
  api: { getHealth: () => getHealth() },
  createApiClient: (base: string) => createApiClientSpy(base),
}));

import SettingsPage from './SettingsPage';
import { getRunnerUrlOverride, resetSettingsMemory } from '../../lib/settings';
import { EXPECTED_CONTRACT_VERSION } from './testConnection';

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const onlineHealth: HealthResponse = {
  ok: true,
  contractVersion: EXPECTED_CONTRACT_VERSION,
  runnerKind: 'mock',
  capabilities: { models: ['mock-model'] },
};

beforeEach(() => {
  getHealth.mockResolvedValue(onlineHealth);
});

afterEach(() => {
  resetSettingsMemory();
  vi.clearAllMocks();
});

describe('runner connection setting', () => {
  it('shows the environment default when no override is set (env wins when unset)', async () => {
    renderPage();
    expect(await screen.findByText(/\(environment default\)/)).toBeInTheDocument();
    expect(screen.getByLabelText('Runner URL')).toHaveAttribute('placeholder', 'http://localhost:4319');
    expect(getRunnerUrlOverride()).toBeNull();
  });

  it('persists a user override on Save and reflects it as the effective (custom) base', async () => {
    const user = userEvent.setup();
    renderPage();

    const input = screen.getByLabelText('Runner URL');
    await user.type(input, 'http://custom:5555');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(getRunnerUrlOverride()).toBe('http://custom:5555');
    expect(await screen.findByText(/\(custom\)/)).toBeInTheDocument();
  });

  it('clears the override with Use environment default', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText('Runner URL'), 'http://custom:5555');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(getRunnerUrlOverride()).toBe('http://custom:5555');

    await user.click(screen.getByRole('button', { name: 'Use environment default' }));
    expect(getRunnerUrlOverride()).toBeNull();
    expect(await screen.findByText(/\(environment default\)/)).toBeInTheDocument();
  });
});

describe('Test Connection', () => {
  it('reports online with runnerKind + contract version, probing the typed URL', async () => {
    const user = userEvent.setup();
    probeHealth.mockResolvedValue(onlineHealth);
    renderPage();

    await user.type(screen.getByLabelText('Runner URL'), 'http://custom:5555');
    await user.click(screen.getByRole('button', { name: 'Test connection' }));

    expect(await screen.findByText(/Online · mock · boardex-contract\/0\.1/)).toBeInTheDocument();
    // The probe client is pointed at the candidate URL in the box, not the saved base.
    expect(createApiClientSpy).toHaveBeenCalledWith('http://custom:5555');
  });

  // D14 (T6.6 review F1, standing ruling): a probe verdict is a warning to resolve,
  // never a fail/stop — the amber dot and amber text must AGREE, and red appears
  // nowhere. The dot is the aria-hidden span inside the verdict line.
  const expectWarnVerdict = (verdict: HTMLElement) => {
    expect(verdict).toHaveClass('text-warn');
    expect(verdict).not.toHaveClass('text-fail');
    const dot = verdict.querySelector('[aria-hidden="true"]');
    expect(dot).toHaveClass('bg-warn');
    expect(dot).not.toHaveClass('bg-fail');
  };

  it('reports offline as an AMBER warning, dot and text agreeing, never red (D14)', async () => {
    const user = userEvent.setup();
    probeHealth.mockRejectedValue(new Error('network down'));
    renderPage();

    await user.click(screen.getByRole('button', { name: 'Test connection' }));

    expectWarnVerdict(await screen.findByText(/Offline — could not reach/));
  });

  it('reports a version mismatch as an AMBER warning, dot and text agreeing, never red (D14)', async () => {
    const user = userEvent.setup();
    probeHealth.mockResolvedValue({ ...onlineHealth, contractVersion: 'boardex-contract/9.9' });
    renderPage();

    await user.click(screen.getByRole('button', { name: 'Test connection' }));

    expectWarnVerdict(await screen.findByText(/≠ expected/));
  });

  it('reports a not-ready runner (degraded) as an AMBER warning, dot and text agreeing, never red (D14)', async () => {
    const user = userEvent.setup();
    probeHealth.mockResolvedValue({ ...onlineHealth, ok: false });
    renderPage();

    await user.click(screen.getByRole('button', { name: 'Test connection' }));

    expectWarnVerdict(await screen.findByText(/reports not ready/));
  });
});

describe('model info (read-only)', () => {
  it('lists the runner-advertised models, marking the first as default', async () => {
    getHealth.mockResolvedValue({
      ...onlineHealth,
      capabilities: { models: ['mock-model', 'mock-model-pro'] },
    });
    renderPage();

    expect(await screen.findByText('mock-model')).toBeInTheDocument();
    expect(screen.getByText('mock-model-pro')).toBeInTheDocument();
    expect(screen.getByText('default')).toBeInTheDocument();
  });

  it('states there are no options when the runner advertises none', async () => {
    getHealth.mockResolvedValue({
      ok: true,
      contractVersion: EXPECTED_CONTRACT_VERSION,
      runnerKind: 'mock',
    });
    renderPage();

    expect(await screen.findByText(/advertises no model options/)).toBeInTheDocument();
  });
});
