import { createStore } from "./store";

/** Any screen can ask to open the host login dialog. */
export const loginRequest = createStore(false);
export const requestLogin = () => loginRequest.set(true);
