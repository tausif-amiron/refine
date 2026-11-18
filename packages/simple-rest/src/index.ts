import { stringify } from "query-string";
import { dataProvider } from "./provider.js";

export default dataProvider;

export type {
  CursorResponse,
  SimpleRestCursorOptions,
  SimpleRestOptions,
} from "./provider.js";

export * from "./utils/index.js";

export { stringify };
