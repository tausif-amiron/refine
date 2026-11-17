import type { Pagination } from "../../../contexts/data/types";

type HandlePaginationParamsProps = {
  pagination?: Pagination;
};

/**
 * Returns true when pagination is done by the server (offset or cursor).
 */
export const isServerSide = (mode?: Pagination["mode"]) =>
  mode === "server" || mode === "cursor";

export const handlePaginationParams = ({
  pagination,
}: HandlePaginationParamsProps = {}): Required<Omit<Pagination, "cursor">> &
  Pick<Pagination, "cursor"> => {
  const mode = pagination?.mode ?? "server";

  const currentPage = pagination?.currentPage ?? 1;

  const pageSize = pagination?.pageSize ?? 10;

  return {
    currentPage,
    pageSize,
    mode,
    ...(mode === "cursor" ? { cursor: pagination?.cursor } : {}),
  };
};
