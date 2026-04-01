import { beforeEach, describe, expect, mock, test } from "bun:test";
import { fireEvent } from "@testing-library/react";
import { cleanup, render } from "../../__tests__/setup.js";
import { DataTable } from "./data-table.js";

const COLUMNS = [
  { key: "name", label: "Name", sortable: true },
  { key: "status", label: "Status" },
  { key: "count", label: "Count", sortable: true },
] as const;

const ROWS = [
  { name: "Alpha", status: "active", count: 10 },
  { name: "Charlie", status: "idle", count: 5 },
  { name: "Bravo", status: "active", count: 20 },
];

describe("DataTable", () => {
  beforeEach(() => {
    cleanup();
  });

  test("renders column headers", () => {
    const { getByText } = render(<DataTable columns={COLUMNS} rows={ROWS} />);
    expect(getByText("Name")).toBeDefined();
    expect(getByText("Status")).toBeDefined();
    expect(getByText("Count")).toBeDefined();
  });

  test("renders rows", () => {
    const { getByText, getAllByText } = render(<DataTable columns={COLUMNS} rows={ROWS} />);
    expect(getByText("Alpha")).toBeDefined();
    expect(getByText("Charlie")).toBeDefined();
    expect(getByText("Bravo")).toBeDefined();
    expect(getAllByText("active")).toHaveLength(2);
  });

  test("sorts when clicking sortable column header", () => {
    const { container, getByText } = render(<DataTable columns={COLUMNS} rows={ROWS} />);

    // Click "Name" header to sort ascending
    fireEvent.click(getByText("Name"));

    const cells = container.querySelectorAll("tbody td:first-child");
    const names = Array.from(cells).map((td) => td.textContent);
    expect(names).toEqual(["Alpha", "Bravo", "Charlie"]);

    // Click again to sort descending
    fireEvent.click(getByText("Name"));

    const cellsDesc = container.querySelectorAll("tbody td:first-child");
    const namesDesc = Array.from(cellsDesc).map((td) => td.textContent);
    expect(namesDesc).toEqual(["Charlie", "Bravo", "Alpha"]);
  });

  test("calls onRowClick when row is clicked", () => {
    const handleClick = mock(() => {});
    const { getByText } = render(<DataTable columns={COLUMNS} rows={ROWS} onRowClick={handleClick} />);

    fireEvent.click(getByText("Alpha"));
    expect(handleClick).toHaveBeenCalledTimes(1);
    expect(handleClick.mock.calls[0]?.[0]).toEqual({
      name: "Alpha",
      status: "active",
      count: 10,
    });
  });
});
