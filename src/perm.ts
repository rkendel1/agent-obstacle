import { createContext, useContext } from "react";
import { can } from "./lib";

export const PermissionContext = createContext<readonly string[]>([]);

/** UI hint only. The server enforces every permission on every call. */
export function useCan(permission: string): boolean {
  return can(useContext(PermissionContext), permission);
}
