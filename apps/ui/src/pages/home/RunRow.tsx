// One run in the Home list (BIBLE §7.1): title, board name, status badge, updated-at,
// and the next action as a real button. Needs-attention rows get the accent (primary)
// button; everything else gets a quiet secondary one.
import { useNavigate } from 'react-router-dom';
import type { RunSummary } from '@boardex/contract';
import { Badge, Button } from '../../design';
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
    <li className="flex items-center gap-4 px-5 py-4">
      <div className="min-w-0 flex-1">
        <button
          type="button"
          onClick={() => navigate(`/runs/${run.id}`)}
          className="block max-w-full truncate text-left text-body font-medium text-text-primary hover:text-accent"
        >
          {run.title}
        </button>
        <p className="mt-0.5 truncate text-meta text-text-secondary">{boardName}</p>
      </div>

      <Badge kind="status" value={run.status} />

      <time
        dateTime={run.updatedAt}
        className="hidden w-20 shrink-0 text-right text-meta text-text-secondary sm:block"
      >
        {timeAgo(run.updatedAt)}
      </time>

      <Button
        variant={attention === 'needs-attention' ? 'primary' : 'secondary'}
        onClick={() => navigate(action.route)}
        className="shrink-0"
      >
        {action.label}
      </Button>
    </li>
  );
}
