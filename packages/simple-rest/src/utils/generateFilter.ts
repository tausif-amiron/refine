import type { CrudFilters } from "@refinedev/core";
import { mapOperator } from "./mapOperator";

const supportedOperators: string[] = [
  "eq",
  "in",
  "ne",
  "gte",
  "lte",
  "contains",
];

const unsupportedMessage = (operator: string) =>
  `[@refinedev/simple-rest]: \`operator: ${operator}\` is not supported. You can create custom data provider. https://refine.dev/docs/api-reference/core/providers/data-provider/#creating-a-data-provider`;

export const generateFilter = (filters?: CrudFilters) => {
  const queryFilters: { [key: string]: string } = {};

  if (filters) {
    filters.forEach((filter) => {
      if (filter.operator === "or" || filter.operator === "and") {
        throw new Error(unsupportedMessage(filter.operator));
      }

      if ("field" in filter) {
        const { field, operator, value } = filter;

        if (field === "q") {
          queryFilters[field] = value;
          return;
        }

        if (
          operator !== undefined &&
          operator !== null &&
          !supportedOperators.includes(operator)
        ) {
          throw new Error(unsupportedMessage(operator));
        }

        const mappedOperator = mapOperator(operator);
        queryFilters[`${field}${mappedOperator}`] = value;
      }
    });
  }

  return queryFilters;
};
