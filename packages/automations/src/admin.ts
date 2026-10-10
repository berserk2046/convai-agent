/**
 * What the admin uses from the automations engine, without the queue (BullMQ stays out of
 * the admin's bundle).
 */
export { automationContext, renderText } from "./context.ts";
export { effectiveTrigger, findRule, minutesParam, overrideProblems } from "./rules.ts";
export { updateAutomationSettings } from "./settings.ts";
export { fillBody, resolveVariables } from "./variables.ts";
