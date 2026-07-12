import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Drawer } from '../Drawer';

function setup(open: boolean) {
  const onClose = vi.fn();
  const view = render(
    <Drawer open={open} title="Board profile" onClose={onClose}>
      <p>Drawer body</p>
    </Drawer>,
  );
  return { onClose, view };
}

describe('Drawer', () => {
  it('renders nothing when closed', () => {
    setup(false);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders an accessible dialog labelled by its title', () => {
    setup(true);
    const dialog = screen.getByRole('dialog', { name: 'Board profile' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByText('Drawer body')).toBeInTheDocument();
  });

  // The exit-presence hook keeps the panel mounted only while the exit
  // animation plays; with a zero computed duration (jsdom, reduced motion)
  // the unmount is synchronous.
  it('unmounts when open flips false', () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <Drawer open title="Board profile" onClose={onClose}>
        <p>Drawer body</p>
      </Drawer>,
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    rerender(
      <Drawer open={false} title="Board profile" onClose={onClose}>
        <p>Drawer body</p>
      </Drawer>,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('calls onClose on Escape', async () => {
    const user = userEvent.setup();
    const { onClose } = setup(true);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when the Close button is clicked', async () => {
    const user = userEvent.setup();
    const { onClose } = setup(true);
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // Regression (T6.3 stage 0): the profile-details drawer is mounted inside the
  // `position: sticky` board rail, which establishes a stacking context; rendered
  // inline the overlay's z-50 would be scoped to that rail and the sibling sticky
  // status rail could paint over it. Portaling to <body> lifts the overlay out of
  // every sticky ancestor so nothing underneath can bleed through.
  it('portals the overlay to document.body, escaping a sticky ancestor', () => {
    const sticky = document.createElement('div');
    sticky.style.position = 'sticky';
    sticky.setAttribute('data-sticky-rail', '');
    document.body.appendChild(sticky);

    render(
      <Drawer open title="Board profile" onClose={vi.fn()}>
        <p>Drawer body</p>
      </Drawer>,
      { container: sticky },
    );

    const dialog = screen.getByRole('dialog', { name: 'Board profile' });
    // The dialog is NOT a descendant of the sticky rail — it lives at body level.
    expect(sticky.contains(dialog)).toBe(false);
    expect(document.body.contains(dialog)).toBe(true);

    document.body.removeChild(sticky);
  });
});
