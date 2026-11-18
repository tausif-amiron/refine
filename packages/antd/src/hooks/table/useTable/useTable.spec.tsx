import React from "react";
import type { CrudFilters } from "@refinedev/core";
import isEqual from "lodash/isEqual";
import { renderHook, waitFor } from "@testing-library/react";
import { Form, Input, Table } from "antd";
import { act, TestWrapper, render, fireEvent, MockJSONServer } from "@test";

import { useTable } from "./useTable";

const defaultPagination = {
  pageSize: 10,
  current: 1,
  total: 2,
  simple: true,
  position: ["bottomCenter"],
};

const customPagination = {
  current: 2,
  pageSize: 1,
  total: 2,
  simple: true,
  position: ["bottomCenter"],
};

const routerProvider = {
  parse: () => {
    return () => ({
      resource: {
        name: "posts",
      },
    });
  },
};

describe("useTable Hook", () => {
  it("default", async () => {
    const { result } = renderHook(() => useTable(), {
      wrapper: TestWrapper({
        routerProvider,
      }),
    });

    await waitFor(() => {
      expect(!result.current.tableProps.loading).toBeTruthy();
    });

    const {
      tableProps: { pagination, dataSource },
    } = result.current;

    expect(dataSource).toHaveLength(2);
    expect(pagination).toEqual(expect.objectContaining(defaultPagination));
  });

  it("with initial pagination parameters", async () => {
    const { result } = renderHook(
      () =>
        useTable({
          pagination: {
            currentPage: customPagination.current,
            pageSize: customPagination.pageSize,
          },
        }),
      {
        wrapper: TestWrapper({
          routerProvider,
        }),
      },
    );

    await waitFor(() => {
      expect(!result.current.tableProps.loading).toBeTruthy();
    });

    const {
      tableProps: { pagination },
    } = result.current;

    expect(pagination).toEqual(expect.objectContaining(customPagination));
  });

  it("with custom resource", async () => {
    const { result } = renderHook(
      () =>
        useTable({
          resource: "categories",
        }),
      {
        wrapper: TestWrapper({
          routerProvider,
        }),
      },
    );

    await waitFor(() => {
      expect(!result.current.tableProps.loading).toBeTruthy();
    });

    const {
      tableProps: { dataSource },
    } = result.current;

    expect(dataSource).toHaveLength(2);
  });

  it("with syncWithLocation", async () => {
    const { result } = renderHook(
      () =>
        useTable({
          resource: "categories",
          syncWithLocation: true,
        }),
      {
        wrapper: TestWrapper({
          routerProvider,
        }),
      },
    );

    await waitFor(() => {
      expect(!result.current.tableProps.loading).toBeTruthy();
    });

    const {
      tableProps: { dataSource },
    } = result.current;

    expect(dataSource).toHaveLength(2);
  });

  it("should success data with resource", async () => {
    const { result } = renderHook(
      () =>
        useTable({
          resource: "categories",
        }),
      {
        wrapper: TestWrapper({
          routerProvider,
        }),
      },
    );

    await waitFor(() => {
      expect(result.current.tableQuery.isSuccess).toBeTruthy();
    });
  });

  it("should set filters manually with `setFilters`", async () => {
    const initialFilter: CrudFilters = [
      {
        field: "name",
        operator: "contains",
        value: "test",
      },
    ];

    const { result } = renderHook(
      () =>
        useTable({
          resource: "categories",
          filters: {
            initial: initialFilter,
          },
        }),
      {
        wrapper: TestWrapper({
          routerProvider,
        }),
      },
    );

    const nextFilters: CrudFilters = [
      {
        field: "name",
        operator: "contains",
        value: "x",
      },
      {
        field: "id",
        operator: "gte",
        value: 1,
      },
    ];

    await waitFor(() => {
      expect(result.current.tableQuery.isSuccess).toBeTruthy();
    });

    await act(async () => {
      result.current.setFilters(nextFilters);
    });

    // TODO: update tests
    await waitFor(() => {
      return isEqual(result.current.filters, [...nextFilters]);
    });
  });

  it('should change behavior to `replace` when `defaultSetFilterBehavior="replace"`', async () => {
    const { result } = renderHook(
      () =>
        useTable({
          resource: "categories",
          filters: {
            initial: [
              {
                field: "name",
                operator: "eq",
                value: "test",
              },
              {
                field: "id",
                operator: "gte",
                value: 1,
              },
            ],
            defaultBehavior: "replace",
          },
        }),
      {
        wrapper: TestWrapper({
          routerProvider,
        }),
      },
    );

    const newFilters: CrudFilters = [
      {
        field: "name",
        operator: "eq",
        value: "next-test",
      },
      {
        field: "other-field",
        operator: "contains",
        value: "other",
      },
    ];

    await act(async () => {
      result.current.setFilters(newFilters);
    });

    await waitFor(() => {
      return isEqual(result.current.filters, newFilters);
    });
  });

  it.each(["client", "server"] as const)(
    "when pagination mode is %s, should set pagination props",
    async (mode) => {
      const { result } = renderHook(
        () =>
          useTable({
            pagination: {
              mode,
            },
          }),
        {
          wrapper: TestWrapper({
            routerProvider,
          }),
        },
      );

      expect(result.current.tableProps.pagination).toEqual(
        expect.objectContaining({
          pageSize: 10,
          current: 1,
        }),
      );
    },
  );

  it("when pagination mode is off, pagination should be false", async () => {
    const { result } = renderHook(
      () =>
        useTable({
          pagination: {
            mode: "off",
          },
        }),
      {
        wrapper: TestWrapper({
          routerProvider,
        }),
      },
    );

    expect(result.current.tableProps.pagination).toBeFalsy();
  });

  it("should pass form values to search form from params (syncWithLocation)", async () => {
    const Component = () => {
      const { searchFormProps } = useTable({
        resource: "categories",
        syncWithLocation: true,
      });

      return (
        <Form {...searchFormProps}>
          <Form.Item name="name" noStyle>
            <Input
              data-test-id="search-name"
              size="large"
              placeholder="Search by name"
            />
          </Form.Item>
        </Form>
      );
    };

    const { getByDisplayValue } = render(<Component />, {
      wrapper: TestWrapper({
        routerProvider: {
          parse: () => {
            return () => ({
              resource: {
                name: "posts",
              },
              params: {
                filters: [
                  {
                    field: "name",
                    operator: "contains",
                    value: "Some Name To Look For",
                  },
                ],
              },
            });
          },
        },
      }),
    });

    await waitFor(() => {
      expect(getByDisplayValue("Some Name To Look For")).toBeInTheDocument();
    });
  });

  it("should work with query and queryResult", async () => {
    const { result } = renderHook(() => useTable(), {
      wrapper: TestWrapper({
        dataProvider: MockJSONServer,
        resources: [{ name: "posts" }],
        routerProvider,
      }),
    });

    await waitFor(() => {
      expect(result.current.tableQuery.isSuccess).toBeTruthy();
    });

    expect(result.current.tableQuery).toEqual(result.current.tableQuery);
  });

  it("pin: in server mode, table onChange sets currentPage and pageSize", async () => {
    const { result } = renderHook(
      () => useTable({ pagination: { mode: "server" } }),
      { wrapper: TestWrapper({ routerProvider }) },
    );

    await act(async () => {
      (result.current.tableProps.onChange as any)(
        { current: 2, pageSize: 20 },
        {},
        {},
      );
    });

    expect(result.current.currentPage).toBe(2);
    expect(result.current.pageSize).toBe(20);
  });

  it("pin: when pagination mode is off, table onChange does not change currentPage", async () => {
    const { result } = renderHook(
      () => useTable({ pagination: { mode: "off" } }),
      { wrapper: TestWrapper({ routerProvider }) },
    );

    await act(async () => {
      (result.current.tableProps.onChange as any)(
        { current: 3, pageSize: 20 },
        {},
        {},
      );
    });

    expect(result.current.currentPage).toBe(1);
    expect(result.current.pageSize).toBe(10);
  });

  describe("cursor mode", () => {
    const pages: Record<string, any> = {
      first: { data: [{ id: "row-1" }], cursor: { next: "c2" } },
      c2: { data: [{ id: "row-2" }], cursor: { next: "c3", prev: "first" } },
      c3: { data: [{ id: "row-3" }], cursor: { prev: "c2" } },
    };

    const cursorDataProvider = (total?: number) =>
      ({
        ...MockJSONServer,
        getList: async ({ pagination }: any) => {
          const page = pages[pagination?.cursor ?? "first"];
          return { ...page, ...(total !== undefined ? { total } : {}) };
        },
      }) as any;

    const CursorTable = () => {
      const { tableProps } = useTable({ pagination: { mode: "cursor" } });
      return (
        <Table
          {...tableProps}
          rowKey="id"
          columns={[{ dataIndex: "id", title: "ID" }]}
        />
      );
    };

    const renderCursorTable = (total?: number) =>
      render(<CursorTable />, {
        wrapper: TestWrapper({
          routerProvider,
          dataProvider: cursorDataProvider(total),
        }),
      });

    const isDisabled = (el: Element | null) =>
      el?.getAttribute("aria-disabled") === "true";

    it("renders only prev/next controls instead of numbered page links", async () => {
      const { container, findByText } = renderCursorTable();
      await findByText("row-1");

      expect(container.querySelector(".ant-pagination-prev")).not.toBeNull();
      expect(container.querySelector(".ant-pagination-next")).not.toBeNull();
      expect(container.querySelectorAll(".ant-pagination-item")).toHaveLength(
        0,
      );
      expect(container.querySelector(".ant-pagination-simple")).toBeNull();
      expect(container.querySelector(".ant-pagination-total-text")).toBeNull();
    });

    it("on the first page, prev is disabled and next is enabled", async () => {
      const { container, findByText } = renderCursorTable();
      await findByText("row-1");

      expect(isDisabled(container.querySelector(".ant-pagination-prev"))).toBe(
        true,
      );
      expect(isDisabled(container.querySelector(".ant-pagination-next"))).toBe(
        false,
      );
    });

    it("the next control goes to the next cursor page", async () => {
      const { container, findByText } = renderCursorTable();
      await findByText("row-1");

      fireEvent.click(container.querySelector(".ant-pagination-next")!);

      await findByText("row-2");
      expect(isDisabled(container.querySelector(".ant-pagination-prev"))).toBe(
        false,
      );
    });

    it("the prev control goes back to the previous cursor page", async () => {
      const { container, findByText } = renderCursorTable();
      await findByText("row-1");

      fireEvent.click(container.querySelector(".ant-pagination-next")!);
      await findByText("row-2");

      fireEvent.click(container.querySelector(".ant-pagination-prev")!);
      await findByText("row-1");
      expect(isDisabled(container.querySelector(".ant-pagination-prev"))).toBe(
        true,
      );
    });

    it("on the last page, next is disabled", async () => {
      const { container, findByText } = renderCursorTable();
      await findByText("row-1");

      fireEvent.click(container.querySelector(".ant-pagination-next")!);
      await findByText("row-2");
      fireEvent.click(container.querySelector(".ant-pagination-next")!);
      await findByText("row-3");

      expect(isDisabled(container.querySelector(".ant-pagination-next"))).toBe(
        true,
      );
      expect(isDisabled(container.querySelector(".ant-pagination-prev"))).toBe(
        false,
      );
    });

    it("shows the total when the provider returns one", async () => {
      const { container, findByText } = renderCursorTable(57);
      await findByText("row-1");

      expect(
        container.querySelector(".ant-pagination-total-text")?.textContent,
      ).toContain("57");
    });

    it("exposes next, prev, hasNextPage and hasPreviousPage", async () => {
      const { result } = renderHook(
        () => useTable({ pagination: { mode: "cursor" } }),
        {
          wrapper: TestWrapper({
            routerProvider,
            dataProvider: cursorDataProvider(),
          }),
        },
      );

      await waitFor(() => {
        expect(result.current.hasNextPage).toBe(true);
      });
      expect(result.current.hasPreviousPage).toBe(false);

      await act(async () => {
        result.current.next();
      });

      await waitFor(() => {
        expect(result.current.hasPreviousPage).toBe(true);
      });
    });
  });
});
