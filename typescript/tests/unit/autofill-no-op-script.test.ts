import { expect, it } from "vitest";
import { noOpScriptCode } from "../../src/destinations/autofill-locate-code.js";

const noOpScript = (0, eval)(noOpScriptCode) as (
  address: unknown,
  formAction?: boolean,
  formLink?: boolean,
) => boolean;

// Only a script action that does nothing is the page's own script submit. Any other script runs
// what its address says, so its form is judged as any form whose action is off the site.
it.each([
  "javascript:",
  "javascript:;",
  "javascript:void(0)",
  "javascript:void(0);",
  "javascript:void 0",
  "javascript:void 0;",
  "JAVASCRIPT:void(0)",
  " javascript: void ( 0 ) ; ",
  "java\tscript:void(0)",
  "java\nscript:vo\nid(0)",
  "javascript:%20void%280%29",
  // A line break after void is whitespace inside one expression: void (0), void 0.
  "javascript:void%0A(0)",
  "javascript:void%0A0",
  "javascript:void%0D%0A(0)",
  "javascript:void%E2%80%A8(0)",
  "javascript:void%C2%A00",
  "javascript:%EF%BB%BFvoid(0)",
])("counts %j as a script action that does nothing", (address) => {
  expect(noOpScript(address)).toBe(true);
});

// The React toolkit's placeholders on a form whose submit its own code handles, as its server
// rendering and its client rendering write them, and the one it writes in place of a form action
// that is a script of the app's own, count as a form's own script submit too.
it.each([
  "javascript:throw new Error('React form unexpectedly submitted.')",
  'javascript:throw new Error("React form unexpectedly submitted.")',
  "javascript:throw new Error('A React form was unexpectedly submitted. If you called form.submit() manually, consider using form.requestSubmit() instead. If you\\'re trying to use event.stopPropagation() in a submit event handler, consider also calling event.preventDefault().')",
  'javascript:throw new Error("A React form was unexpectedly submitted. If you called form.submit() manually, consider using form.requestSubmit() instead. If you\'re trying to use event.stopPropagation() in a submit event handler, consider also calling event.preventDefault().")',
  "javascript:throw new Error('React has blocked a javascript: URL as a security precaution.')",
  'javascript:throw new Error("React has blocked a javascript: URL as a security precaution.")',
])("counts %j as a form's own script submit", (address) => {
  expect(noOpScript(address, true)).toBe(true);
});

// Only the exact placeholder throws and does nothing else: another message, a second statement or
// a call runs what it says.
it.each([
  "javascript:throw new Error('React has blocked a javascript: URL.')",
  "javascript:throw new TypeError('React has blocked a javascript: URL as a security precaution.')",
  "javascript:throw new Error('React has blocked a javascript: URL as a security precaution.');send()",
  "javascript:throw new Error('React has blocked a javascript: URL as a security precaution.'+send())",
  "javascript:throw new Error(send('React has blocked a javascript: URL as a security precaution.'))",
  "javascript:throw new Error('React has blocked a javascript: URL as a security precaution.\")",
])("does not count %j as a form's own script submit", (address) => {
  expect(noOpScript(address, true)).toBe(false);
});

// The ASP.NET Web Forms postback of a control, as the address of a link in a form, counts too: it
// only submits the page's form, whose own action is still judged.
const postBack = "javascript:__doPostBack('ctl00$Login1$LoginButton','')";
it.each([postBack, "javascript:__doPostBack('LoginButton','')", "javascript:__doPostBack('_ctl0$Login$Submit','')"])(
  "counts %j as the postback of a link in a form",
  (address) => {
    expect(noOpScript(address, false, true)).toBe(true);
  },
);

// Only the exact call with one control name and an empty argument: another argument, a second
// statement, a call, other quotes or a name with other characters runs what it says.
it.each([
  "javascript:__doPostBack('ctl00$Login1$LoginButton','','x')",
  "javascript:__doPostBack('ctl00$Login1$LoginButton','x')",
  "javascript:__doPostBack('ctl00$Login1$LoginButton')",
  "javascript:__doPostBack('ctl00$Login1$LoginButton',send())",
  "javascript:__doPostBack(send(),'')",
  "javascript:__doPostBack('ctl00$Login1$LoginButton','');send()",
  "javascript:__doPostBack('ctl00$Login1$LoginButton','');",
  "javascript:__doPostBack('ctl00$Login1$LoginButton', '')",
  "javascript: __doPostBack('ctl00$Login1$LoginButton','')",
  'javascript:__doPostBack("ctl00$Login1$LoginButton","")',
  "javascript:__doPostBack('a'+send()+'b','')",
  "javascript:__doPostBack('a\\'+send()+\\'b','')",
  "javascript:__doPostBack('','')",
  "javascript:__doPostBack('1ctl','')",
  "javascript:__doPostBack('ctl00.Login1','')",
  "javascript:__doPostBack('ctl00:Login1','')",
  "javascript:__doPostBack('ctl00%27);send(%27','')",
  "javascript:__DoPostBack('ctl00$Login1$LoginButton','')",
  "javascript:void(__doPostBack('ctl00$Login1$LoginButton',''))",
  "javascript:__doPostBack('ctl00$Login1$LoginButton','')//",
])("does not count %j as the postback of a link in a form", (address) => {
  expect(noOpScript(address, false, true)).toBe(false);
});

// A postback counts only as the address of a link in a form, never outside one or as a form's own
// action or a formaction.
it("does not count a postback as a link's address outside a form or as a form's own action", () => {
  expect(noOpScript(postBack)).toBe(false);
  expect(noOpScript(postBack, true)).toBe(false);
});

it.each([
  "javascript:send()",
  "javascript:void(send())",
  "javascript:void(0);send()",
  "javascript:;send()",
  "javascript:void(1)",
  "javascript:void(0)//",
  "javascript:/**/void(0)",
  "javascript:void(0)?x=1",
  "javascript:void(0)#x",
  "javascript:%E0%A4%A",
  "javascript:%73end()",
  "javascript:%2576oid(0)",
  // Script is case-sensitive: these call a function of the page's own named Void or VOID.
  "javascript:Void(0)",
  "javascript:VOID(0)",
  // A line break inside the name splits it into two statements, the second a call of the page's
  // function named id; other whitespace inside it, or a zero-width space, is no script either.
  "javascript:vo%0Aid(0)",
  "javascript:voi%0Ad(0)",
  "javascript:v%0Aoid(0)",
  "javascript:vo%0D%0Aid(0)",
  "javascript:vo%E2%80%A8id(0)",
  "javascript:vo%C2%A0id(0)",
  "javascript:void%E2%80%8B(0)",
  "javascript:void0",
  // A placeholder counts only as a form's own action, never as a link's address or a formaction.
  "javascript:throw new Error('React has blocked a javascript: URL as a security precaution.')",
  "https://member.example.test/session",
  "data:,void(0)",
  "",
  null,
])("does not count %j as a script action that does nothing", (address) => {
  expect(noOpScript(address)).toBe(false);
});
