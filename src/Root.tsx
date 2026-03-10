import { useEffect, useState } from 'react';

import { App } from './App.tsx';
import { WorkflowRunPage } from './pages/WorkflowRunPage.tsx';

type RootRoute =
  | {
      kind: 'control-room';
    }
  | {
      kind: 'workflow-runs';
      runId: string | null;
    };

function parseRoute(pathname: string): RootRoute {
  const workflowRunMatch = pathname.match(/^\/workflow-runs(?:\/([^/]+))?\/?$/);
  if (workflowRunMatch) {
    return {
      kind: 'workflow-runs',
      runId: workflowRunMatch[1] ?? null,
    };
  }

  return { kind: 'control-room' };
}

function navigate(pathname: string, replace = false) {
  if (replace) {
    window.history.replaceState(null, '', pathname);
  } else {
    window.history.pushState(null, '', pathname);
  }
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function Root() {
  const [route, setRoute] = useState<RootRoute>(() => parseRoute(window.location.pathname));

  useEffect(() => {
    const handlePopState = () => {
      setRoute(parseRoute(window.location.pathname));
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  if (route.kind === 'workflow-runs') {
    return (
      <WorkflowRunPage
        runId={route.runId}
        onNavigate={(nextPath, replace) => navigate(nextPath, replace)}
      />
    );
  }

  return <App />;
}
