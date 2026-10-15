/**
 * @Author Christian Relf
 * @Date 2026-10-15
 */

import { describe, expect, it } from "vitest";
import { countTasks, detect, nameFromFile, parseCsv, parseExport, parseLooseDate } from "./parsers";

describe("csv", () => {
  it("handles quotes, commas, newlines and CRLF", () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi""\nthere"\r\n\r\n')).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"\nthere'],
    ]);
  });
});

describe("dates", () => {
  it("reads the common export formats", () => {
    expect(parseLooseDate("2026-10-20")).toEqual({ date: "2026-10-20", time: null });
    expect(parseLooseDate("2026/10/20 9:30 PM")).toEqual({ date: "2026-10-20", time: "21:30" });
    expect(parseLooseDate("October 20, 2026")).toEqual({ date: "2026-10-20", time: null });
    expect(parseLooseDate("20 Oct 2026")).toEqual({ date: "2026-10-20", time: null });
    expect(parseLooseDate("Oct 3rd 2026 10:00")).toEqual({ date: "2026-10-03", time: "10:00" });
    expect(parseLooseDate("10/20/2026")?.date).toBe("2026-10-20");
    expect(parseLooseDate("20/10/2026")?.date).toBe("2026-10-20");
    expect(parseLooseDate("October 20, 2026 → October 22, 2026")?.date).toBe("2026-10-20");
    expect(parseLooseDate("every day")).toBeNull();
    expect(parseLooseDate("2026-02-30")).toBeNull();
  });

  it("names projects from files", () => {
    expect(nameFromFile("C:\\exports\\Tasks 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d.csv")).toBe("Tasks");
    expect(nameFromFile("home_renovation.csv")).toBe("home renovation");
  });
});

describe("todoist", () => {
  const csv = [
    "TYPE,CONTENT,DESCRIPTION,PRIORITY,INDENT,AUTHOR,RESPONSIBLE,DATE,DATE_LANG,TIMEZONE,DURATION,DURATION_UNIT",
    "task,Buy paint @errands,,1,1,,,2026-10-20,en,,30,minute",
    "task,Pick colours,,4,2,,,,en,,,",
    "note,Ask about samples,,,,,,,,,,",
    "section,Next week,,,,,,,,,,",
    "task,Sand walls,,2,1,,,every monday,en,,,",
  ].join("\n");
  it("keeps nesting, sections, priorities and labels", () => {
    expect(detect("Home.csv", csv)).toBe("todoist");
    const b = parseExport("Home.csv", csv);
    expect(b.projects[0].name).toBe("Home");
    expect(b.projects[0].columns?.map((c) => c.name)).toEqual(["Backlog", "Next week", "Done"]);
    const [paint, sand] = b.tasks;
    expect(paint).toMatchObject({ title: "Buy paint", priority: 4, dueDate: "2026-10-20", estimateMinutes: 30, labels: ["errands"], column: "Backlog" });
    expect(paint.subtasks?.[0]).toMatchObject({ title: "Pick colours", description: "Ask about samples" });
    expect(sand).toMatchObject({ column: "Next week", priority: 3, dueDate: null });
    expect(sand.description).toContain("Due: every monday");
    expect(countTasks(b.tasks)).toBe(3);
  });
});

describe("trello", () => {
  it("maps lists, cards, labels and checklists", () => {
    const board = {
      name: "Website",
      lists: [
        { id: "l1", name: "To Do", pos: 1 },
        { id: "l2", name: "Doing", pos: 2 },
        { id: "l3", name: "Done", pos: 3 },
        { id: "l4", name: "Old", closed: true, pos: 4 },
      ],
      labels: [{ id: "g", name: "", color: "green" }, { id: "u", name: "Urgent", color: "red" }],
      cards: [
        { id: "c1", name: "Homepage", idList: "l2", idLabels: ["u", "g"], due: "2026-10-20T09:00:00.000Z", pos: 1 },
        { id: "c2", name: "Logo", idList: "l3", pos: 2 },
        { id: "c3", name: "Archived", idList: "l1", closed: true },
        { id: "c4", name: "In a closed list", idList: "l4" },
      ],
      checklists: [{ id: "k", idCard: "c1", checkItems: [{ name: "Copy", state: "complete", pos: 2 }, { name: "Hero image", state: "incomplete", pos: 1 }] }],
    };
    const text = JSON.stringify(board);
    expect(detect("board.json", text)).toBe("trello");
    const b = parseExport("board.json", text);
    expect(b.projects[0].columns).toEqual([
      { name: "To Do", status: "todo" },
      { name: "Doing", status: "in_progress" },
      { name: "Done", status: "completed" },
    ]);
    expect(b.tasks.map((t) => t.title)).toEqual(["Homepage", "Logo"]);
    expect(b.tasks[0].labels).toEqual(["Urgent", "green"]);
    expect(b.tasks[0].subtasks?.map((s) => [s.title, s.status])).toEqual([
      ["Hero image", "todo"],
      ["Copy", "completed"],
    ]);
    expect(b.tasks[1].status).toBe("completed");
  });
});

describe("linear", () => {
  it("groups by project, nests sub-issues and skips cancelled ones", () => {
    const csv = [
      "ID,Team,Title,Description,Status,Estimate,Priority,Project,Labels,Created,Completed,Due Date,Parent issue",
      "ENG-1,Engineering,Ship v2,Big one,In Progress,5,Urgent,Launch,\"backend, api\",2026-09-01T10:00:00.000Z,,2026-11-01,",
      "ENG-2,Engineering,Write docs,,Todo,,Low,Launch,,,,,ENG-1",
      "ENG-3,Engineering,Old idea,,Canceled,,,,,,,,",
      "ENG-4,Engineering,Fix login,,Done,,High,,bug,,2026-09-10T10:00:00.000Z,,",
    ].join("\n");
    expect(detect("export.csv", csv)).toBe("linear");
    const b = parseExport("export.csv", csv);
    expect(b.projects.map((p) => p.name)).toEqual(["Launch", "Engineering"]);
    expect(b.tasks.map((t) => t.title)).toEqual(["Ship v2", "Fix login"]);
    expect(b.tasks[0]).toMatchObject({ column: "In Progress", priority: 4, dueDate: "2026-11-01", labels: ["backend", "api"] });
    expect(b.tasks[0].subtasks?.[0].title).toBe("Write docs");
    expect(b.tasks[1]).toMatchObject({ status: "completed", column: "Done", priority: 3 });
  });
});

describe("notion and plain csv", () => {
  it("finds the columns by name and keeps the rest", () => {
    const csv = ["Name,Status,Due,Tags,Priority,Assignee", "Book venue,Done,\"October 20, 2026\",\"party, admin\",High,Ana", "Send invites,In progress,,,,"].join("\n");
    const b = parseExport("Party 0123456789abcdef0123456789abcdef.csv", csv);
    expect(b.source).toBe("Notion");
    expect(b.projects[0].name).toBe("Party");
    expect(b.tasks[0]).toMatchObject({ title: "Book venue", status: "completed", dueDate: "2026-10-20", labels: ["party", "admin"], priority: 3 });
    expect(b.tasks[0].description).toContain("**Assignee:** Ana");
    expect(b.tasks[1].status).toBe("in_progress");
  });
});
