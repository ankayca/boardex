// Settings → Model provider (§7.7). The section is FEATURE-DETECTED on /health's
// advertised `credentials` (mock-prototyped, §10.5 proposal), and the key it accepts is
// pass-through: typed, PUT, gone. The lib/credentials seam is spied — the live HTTP
// surface is pinned in tools/mock-runner/src/server.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  CredentialError,
  credentialsApi,
  type CredentialsCapability,
  type ProviderCredential,
} from '../../lib/credentials';
import { ProviderCredentials } from './ProviderCredentials';

const KEY = 'sk-or-v1-typed-by-the-user-92a4';

function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ProviderCredentials />
    </QueryClientProvider>,
  );
}

const advertised = (...providers: ProviderCredential[]): CredentialsCapability => ({
  status: 'advertised',
  providers,
});

const section = () => screen.queryByRole('heading', { name: 'Model provider' });
const keyField = () => screen.getByLabelText('openrouter API key') as HTMLInputElement;
const saveButton = () => screen.getByRole('button', { name: 'Save' });

let fetchCapability: MockInstance<typeof credentialsApi.fetchCapability>;
let put: MockInstance<typeof credentialsApi.put>;
let remove: MockInstance<typeof credentialsApi.remove>;

beforeEach(() => {
  fetchCapability = vi.spyOn(credentialsApi, 'fetchCapability');
  put = vi.spyOn(credentialsApi, 'put').mockResolvedValue(undefined);
  remove = vi.spyOn(credentialsApi, 'remove').mockResolvedValue(undefined);
});

afterEach(() => vi.restoreAllMocks());

describe('feature detection', () => {
  it('renders NOTHING when the runner advertises no credential capability', async () => {
    fetchCapability.mockResolvedValue({ status: 'unsupported' });
    const { container } = renderSection();
    await waitFor(() => expect(fetchCapability).toHaveBeenCalled());
    expect(section()).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the runner is unreachable — absent, never an empty section', async () => {
    fetchCapability.mockRejectedValue(new Error('offline'));
    const { container } = renderSection();
    await waitFor(() => expect(fetchCapability).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the capability is advertised with NO providers in it', async () => {
    // A runner that answers `credentials: []` offers no provider to configure. That is
    // an empty capability, not a broken one — so there is nothing to render, exactly as
    // for an absent one. A section here would be a form with no subject.
    fetchCapability.mockResolvedValue(advertised());
    const { container } = renderSection();
    await waitFor(() => expect(fetchCapability).toHaveBeenCalled());
    expect(section()).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the section per advertised provider once the capability arrives', async () => {
    fetchCapability.mockResolvedValue(
      advertised({ provider: 'openrouter', configured: false }),
    );
    renderSection();
    expect(await screen.findByRole('heading', { name: 'Model provider' })).toBeInTheDocument();
    expect(screen.getByText('openrouter')).toBeInTheDocument();
  });
});

describe('configuration state', () => {
  it('unconfigured: says so, offers no Remove, and disables Save until a key is typed', async () => {
    const user = userEvent.setup();
    fetchCapability.mockResolvedValue(advertised({ provider: 'openrouter', configured: false }));
    renderSection();

    expect(await screen.findByText('Not configured')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
    expect(saveButton()).toBeDisabled();

    await user.type(keyField(), '  ');
    expect(saveButton()).toBeDisabled(); // whitespace is not a key
    await user.type(keyField(), KEY);
    expect(saveButton()).toBeEnabled();
  });

  it('configured: shows the runner’s masked HINT only, and offers Remove', async () => {
    fetchCapability.mockResolvedValue(
      advertised({ provider: 'openrouter', configured: true, hint: '…92a4' }),
    );
    renderSection();

    expect(await screen.findByText('Configured')).toBeInTheDocument();
    expect(screen.getByText('· …92a4')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument();
    // The hint is a tail, and it is the ONLY credential material on the screen.
    expect(document.body.textContent).not.toContain(KEY);
  });

  it('masks what is typed: the field is a password input', async () => {
    fetchCapability.mockResolvedValue(advertised({ provider: 'openrouter', configured: false }));
    renderSection();
    await screen.findByText('Not configured');
    expect(keyField()).toHaveAttribute('type', 'password');
  });
});

describe('saving a key', () => {
  it('PUTs it, re-fetches health, and ALWAYS clears the field — nothing secret rests here', async () => {
    const user = userEvent.setup();
    fetchCapability
      .mockResolvedValueOnce(advertised({ provider: 'openrouter', configured: false }))
      .mockResolvedValue(advertised({ provider: 'openrouter', configured: true, hint: '…92a4' }));
    renderSection();
    await screen.findByText('Not configured');

    await user.type(keyField(), KEY);
    await user.click(saveButton());

    await waitFor(() => expect(put).toHaveBeenCalledWith('openrouter', KEY));
    // Re-fetched: the state line now reflects the runner, hint and all.
    expect(await screen.findByText('Configured')).toBeInTheDocument();
    expect(screen.getByText('· …92a4')).toBeInTheDocument();

    // The field never retains the typed key, and the key appears NOWHERE in the
    // rendered output — only the runner's hint may.
    expect(keyField().value).toBe('');
    expect(document.body.innerHTML).not.toContain(KEY);
    expect(document.body.innerHTML).toContain('…92a4');
  });

  it('clears the field on FAILURE too, and reports the rejection in amber (D14)', async () => {
    const user = userEvent.setup();
    fetchCapability.mockResolvedValue(advertised({ provider: 'openrouter', configured: false }));
    put.mockRejectedValue(new CredentialError('The runner rejected that key — check you pasted the whole value.'));
    renderSection();
    await screen.findByText('Not configured');

    await user.type(keyField(), KEY);
    await user.click(saveButton());

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The runner rejected that key');
    // Amber, never red: a rejected key is a warning to resolve, not a fail/stop.
    expect(alert.className).toContain('text-warn');
    expect(alert.className).not.toContain('text-fail');

    expect(keyField().value).toBe('');
    expect(document.body.innerHTML).not.toContain(KEY);
  });

  it('Remove deletes the key on the runner and re-fetches', async () => {
    const user = userEvent.setup();
    fetchCapability
      .mockResolvedValueOnce(advertised({ provider: 'openrouter', configured: true, hint: '…92a4' }))
      .mockResolvedValue(advertised({ provider: 'openrouter', configured: false }));
    renderSection();

    await user.click(await screen.findByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(remove).toHaveBeenCalledWith('openrouter'));
    expect(await screen.findByText('Not configured')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
  });
});
