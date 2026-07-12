// Sources tab (§7.4, T6.3): lists the profile's documents and renders the selected
// one — markdown via the T5.1 renderer with the locator heading highlighted, PDF via
// a native embed, and a fail-closed unfetchable state. Document content is stubbed at
// the api seam; transport is the mock-runner's own tests.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { BoardDocument } from '@boardex/contract';
import { api } from '../../lib/api';
import { SourcesTab } from './SourcesTab';

const DATASHEET_MD = `# BME280 datasheet

## I2C device addressing

SDO to GND selects 7-bit address 0x76 (wire byte 0xEC).

## Timing specifications

Standard mode 100 kHz.
`;

const datasheet: BoardDocument = {
  id: 'doc_bme280_datasheet',
  label: 'BME280 datasheet (excerpt)',
  kind: 'datasheet',
  mimeType: 'text/markdown',
};
const schematic: BoardDocument = {
  id: 'doc_schematic_notes',
  label: 'Schematic notes',
  kind: 'schematic',
  mimeType: 'text/markdown',
};
const pdfDoc: BoardDocument = {
  id: 'doc_pdf',
  label: 'Reference PDF',
  kind: 'reference',
  mimeType: 'application/pdf',
};

const CONTENT: Record<string, string> = {
  doc_bme280_datasheet: DATASHEET_MD,
  doc_schematic_notes: '# Schematic notes\n\nPB8 = SCL, PB9 = SDA.\n',
};

function renderTab(
  props: { documents: BoardDocument[]; initialDocId?: string | null; locator?: string | null },
) {
  vi.spyOn(api, 'getDocumentText').mockImplementation((id) => {
    const content = CONTENT[id];
    return content !== undefined
      ? Promise.resolve(content)
      : Promise.reject(new Error(`no stub for ${id}`));
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SourcesTab
        documents={props.documents}
        initialDocId={props.initialDocId ?? null}
        locator={props.locator ?? null}
      />
    </QueryClientProvider>,
  );
}

afterEach(() => vi.restoreAllMocks());

describe('SourcesTab', () => {
  it('lists the profile documents and renders the first by default', async () => {
    renderTab({ documents: [datasheet, schematic] });
    const nav = screen.getByRole('navigation', { name: 'Documents' });
    expect(within(nav).getByText('BME280 datasheet (excerpt)')).toBeInTheDocument();
    expect(within(nav).getByText('Schematic notes')).toBeInTheDocument();
    // Default selection is the first document; its markdown renders.
    expect(await screen.findByRole('heading', { name: 'I2C device addressing' })).toBeInTheDocument();
  });

  it('switches document on click', async () => {
    const user = userEvent.setup();
    renderTab({ documents: [datasheet, schematic] });
    await screen.findByRole('heading', { name: 'I2C device addressing' });
    await user.click(screen.getByRole('button', { name: /Schematic notes/ }));
    expect(await screen.findByText('PB8 = SCL, PB9 = SDA.')).toBeInTheDocument();
  });

  it('deep-links to a document and highlights the located heading (markdown locator)', async () => {
    renderTab({
      documents: [datasheet, schematic],
      initialDocId: 'doc_bme280_datasheet',
      locator: 'timing-specifications',
    });
    const located = await screen.findByRole('heading', { name: 'Timing specifications' });
    expect(located).toHaveAttribute('data-located', 'true');
    expect(located).toHaveAttribute('id', 'timing-specifications');
    // A non-located heading carries its slug id but is not highlighted.
    const other = screen.getByRole('heading', { name: 'I2C device addressing' });
    expect(other).toHaveAttribute('id', 'i2c-device-addressing');
    expect(other).not.toHaveAttribute('data-located');
  });

  it('renders a PDF document via a native embed with a fallback link', () => {
    const { container } = renderTab({ documents: [pdfDoc] });
    const object = container.querySelector('object[type="application/pdf"]');
    expect(object).not.toBeNull();
    expect(object?.getAttribute('data')).toContain('/documents/doc_pdf');
    // Fallback content (fail-closed) offers a way to open it.
    expect(screen.getByRole('link', { name: 'Open the PDF' })).toHaveAttribute(
      'href',
      expect.stringContaining('/documents/doc_pdf'),
    );
  });

  it('fails closed on an unfetchable document, offering a retry', async () => {
    renderTab({ documents: [pdfDoc, { ...schematic, id: 'doc_missing' }], initialDocId: 'doc_missing' });
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t load the document');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('shows an empty state when the profile carries no documents', () => {
    renderTab({ documents: [] });
    expect(screen.getByRole('status')).toHaveTextContent('carries no documents');
  });
});
