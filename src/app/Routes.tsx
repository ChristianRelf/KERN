import { lazy, Suspense } from "react";
import { useRouter } from "@/stores/router";
import { DashboardPage } from "@/features/dashboard/DashboardPage";
import { TasksPage } from "@/features/tasks/TasksPage";
import { InboxPage } from "@/features/inbox/InboxPage";
import { ProjectsPage } from "@/features/projects/ProjectsPage";
import { ProjectPage } from "@/features/projects/ProjectPage";
import { TaskPage } from "@/features/tasks/TaskPage";
import { LabelPage } from "@/features/tasks/LabelPage";
import { PageFallback } from "@/components/layout/PageFallback";
import { ErrorBoundary } from "@/components/layout/ErrorBoundary";

// Heavy feature modules load on demand: opening the task list never
// initialises the whiteboard renderer or the rich-text editor.
const WhiteboardsPage = lazy(() => import("@/features/whiteboard/WhiteboardsPage"));
const WhiteboardPage = lazy(() => import("@/features/whiteboard/WhiteboardPage"));
const NotesPage = lazy(() => import("@/features/notes/NotesPage"));
const SettingsPage = lazy(() => import("@/features/settings/SettingsPage"));
const SearchPage = lazy(() => import("@/features/search/SearchPage"));
const TrashPage = lazy(() => import("@/features/trash/TrashPage"));
const FocusPage = lazy(() => import("@/features/focus/FocusPage"));
const RundownPage = lazy(() => import("@/features/daily-briefing/RundownPage"));
const SessionsPage = lazy(() => import("@/features/sessions/SessionsPage"));

export function Routes() {
  const route = useRouter((s) => s.route);
  let page: React.ReactNode;
  switch (route.name) {
    case "dashboard":
      page = <DashboardPage key={route.id ?? "default"} dashboardId={route.id} />;
      break;
    case "tasks":
      page = <TasksPage key="tasks" />;
      break;
    case "view":
      page = <TasksPage key={`view-${route.id}`} viewId={route.id} />;
      break;
    case "label":
      page = <LabelPage key={route.id} labelId={route.id} />;
      break;
    case "inbox":
      page = <InboxPage />;
      break;
    case "projects":
      page = <ProjectsPage />;
      break;
    case "project":
      page = <ProjectPage key={route.id} id={route.id} tab={route.tab} boardId={route.boardId} whiteboardId={route.whiteboardId} column={route.column} />;
      break;
    case "whiteboards":
      page = <WhiteboardsPage />;
      break;
    case "whiteboard":
      page = <WhiteboardPage key={route.id} id={route.id} />;
      break;
    case "notes":
      page = <NotesPage noteId={route.id} />;
      break;
    case "search":
      page = <SearchPage initial={route.q} />;
      break;
    case "settings":
      page = <SettingsPage section={route.section} />;
      break;
    case "api":
      page = <SettingsPage section="api" apiTab={route.tab} />;
      break;
    case "trash":
      page = <TrashPage />;
      break;
    case "focus":
      page = <FocusPage />;
      break;
    case "sessions":
      page = <SessionsPage projectId={route.projectId} />;
      break;
    case "rundown":
      page = <RundownPage key={`${route.day ?? "today"}-${route.mode ?? "morning"}`} day={route.day} mode={route.mode} />;
      break;
    case "task":
      page = <TaskPage key={route.id} id={route.id} />;
      break;
  }
  return (
    <ErrorBoundary resetKey={route}>
      <Suspense fallback={<PageFallback />}>{page}</Suspense>
    </ErrorBoundary>
  );
}
