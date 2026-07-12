// One run in the Home table (BIBLE §7.1, frame v2): status glyph + badge, title,
// board name, updated-at, and the next action as a real button. The whole row is
// clickable (mouse polish); keyboard access rides the title link and the action
// button. Needs-attention rows get the accent (primary) button; everything else
// gets a quiet secondary one.
import type { MouseEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { RunSummary } from '@boardex/contract';
import { Badge, Button, RunStatusIcon } from '../../design';
import { nextAction, runAttention } from './nextAction';
import { timeAgo } from './timeAgo';

export interface RunRowProps {
  run: RunSummary;
  /** Display name for run.boardProfileId; falls back to the id when unresolved. */
  boardName: string;
}

export function RunRow({ run, boardName }: RunRowProps) {
  const navigate = useNavigate();
  const action = nextAction(run.status, run.id);
  const attention = runAttention(run.status);

  return (
    <tr
      onClick={() => navigate(`/runs/${run.id}`)}
      className="cursor-pointer transition-colors duration-fast ease-motion hover:bg-bg-app"
    >
      <td className="px-4 py-3">
        <span className="flex items-center gap-2 whitespace-nowrap">
          <RunStatusIcon status={run.status} className="shrink-0" />
          <Badge kind="status" value={run.status} />
        </span>
      </td>
      <td className="max-w-0 px-4 py-3">
        <Link
          to={`/runs/${run.id}`}
          className="block truncate text-body font-medium text-text-primary hover:text-accent"
        >
          {run.title}
        </Link>
      </td>
      <td className="max-w-0 px-4 py-3">
        <span className="block truncate text-meta text-text-secondary">{boardName}</span>
      </td>
      <td className="px-4 py-3">
        <time
          dateTime={run.updatedAt}
          className="whitespace-nowrap text-meta text-text-secondary"
        >
          {timeAgo(run.updatedAt)}
        </time>
      </td>
      <td className="px-4 py-3 text-right">
        <Button
          variant={attention === 'needs-attention' ? 'primary' : 'secondary'}
          onClick={(event: MouseEvent) => {
            // The row is itself clickable; the action must not double-navigate.
            event.stopPropagation();
            navigate(action.route);
          }}
          className="whitespace-nowrap"
        >
          {action.label}
        </Button>
      </td>
    </tr>
  );
}
