import { Schema } from "effect";
import { CalendarDate, defineOperation } from "../../src/browser/index.js";

// An observed calendar popup: month panels carry data-month (YYYY-MM) and days carry the full
// data-date, so day text alone never identifies a cell. Other sites need their own evidence.
export const pickTravelDate = defineOperation(
  {
    name: "pick_travel_date",
    input: Schema.Struct({
      date: CalendarDate.annotations({ description: "Travel date to pick, YYYY-MM-DD" }),
    }),
    output: Schema.Struct({
      date: CalendarDate.annotations({
        description: "Travel date the field now holds, YYYY-MM-DD",
      }),
    }),
  },
  async ({ kernel, sessionId, input, errors }) => {
    const answer = await kernel.browsers.playwright.execute(sessionId, {
      timeout_sec: 60,
      code: `
        const date = ${JSON.stringify(input.date)};
        const field = page.getByRole("textbox", { name: "Travel date", exact: true });
        await field.click({ timeout: 30000 });
        const popup = page.getByRole("dialog", { name: "Choose date", exact: true });
        await popup.waitFor({ state: "visible", timeout: 30000 });
        // Advance month by month, at most 24 times, checking the shown month after each click.
        for (let step = 0; ; step++) {
          const months = await popup.locator("[data-month]").evaluateAll((panels) =>
            panels.map((panel) => panel.getAttribute("data-month")),
          );
          if (months.includes(date.slice(0, 7))) break;
          if (step === 24 || months.length === 0) return { failure: "month_unavailable" };
          const back = date.slice(0, 7) < months[0];
          await popup.getByRole("button", { name: back ? "Previous month" : "Next month", exact: true }).click({ timeout: 30000 });
          await popup.locator("[data-month=" + JSON.stringify(months[0]) + "]").waitFor({ state: "detached", timeout: 30000 });
        }
        const day = popup.locator("[data-month=" + JSON.stringify(date.slice(0, 7)) + "] [data-date=" + JSON.stringify(date) + "]");
        if ((await day.count()) !== 1) return { failure: "day_ambiguous" };
        if (!(await day.isEnabled()) || (await day.getAttribute("aria-disabled")) === "true")
          return { failure: "day_disabled" };
        await day.click({ timeout: 30000 });
        // A field or URL alone does not prove the date; read the committed ISO value back.
        return (await field.inputValue()) === date ? { date } : { failure: "not_committed" };
      `,
    });
    if (!answer.success)
      throw new errors.OperationFailure(String(answer.error), { stderr: answer.stderr });
    const result = Schema.decodeUnknownSync(
      Schema.Union(
        Schema.Struct({ date: CalendarDate }),
        Schema.Struct({
          failure: Schema.Literal(
            "month_unavailable",
            "day_ambiguous",
            "day_disabled",
            "not_committed",
          ),
        }),
      ),
    )(answer.result);
    if ("failure" in result)
      throw new errors.OperationFailure(result.failure, {
        dispatch: result.failure === "not_committed" ? "sent" : "not_sent",
      });
    return result;
  },
);

// Choosing a file can start an upload at once, so this is a write the host must authorize.
// The bytes travel in the code as base64 and become a Buffer on Kernel's machine.
export default defineOperation(
  {
    name: "attach_document",
    input: Schema.Struct({
      name: Schema.NonEmptyString.annotations({
        description: "File name for the document, with its extension",
      }),
      mime_type: Schema.NonEmptyString.annotations({
        description: "The document's media type, such as application/pdf",
      }),
      content_base64: Schema.String.annotations({ description: "The document's bytes, base64" }),
    }),
    output: Schema.Struct({
      name: Schema.String.annotations({ description: "Name of the file the field now holds" }),
      size: Schema.Number.annotations({ description: "Size of that file in bytes" }),
    }),
  },
  async ({ kernel, sessionId, input, errors }) => {
    const answer = await kernel.browsers.playwright.execute(sessionId, {
      timeout_sec: 60,
      code: `
        const field = page.getByLabel("Documents", { exact: true });
        const selected = () => field.evaluate((node) => [...node.files].map((file) => ({ name: file.name, size: file.size })));
        // Same name and size is not the same content, so never reuse an existing choice.
        if ((await selected()).length > 0) return { failure: "already_selected" };
        await field.setInputFiles(
          {
            name: ${JSON.stringify(input.name)},
            mimeType: ${JSON.stringify(input.mime_type)},
            buffer: Buffer.from(${JSON.stringify(input.content_base64)}, "base64"),
          },
          { timeout: 30000 },
        );
        return { files: await selected() };
      `,
    });
    if (!answer.success)
      throw new errors.OperationFailure(String(answer.error), { stderr: answer.stderr });
    const result = Schema.decodeUnknownSync(
      Schema.Union(
        Schema.Struct({
          files: Schema.Array(Schema.Struct({ name: Schema.String, size: Schema.Number })),
        }),
        Schema.Struct({ failure: Schema.Literal("already_selected") }),
      ),
    )(answer.result);
    if ("failure" in result)
      throw new errors.OperationFailure(result.failure, { dispatch: "not_sent" });
    const file = result.files[0];
    const size = Buffer.from(input.content_base64, "base64").byteLength;
    // Selection is not proof the site accepted the upload; this reads back only the choice.
    if (result.files.length !== 1 || file?.name !== input.name || file.size !== size)
      throw new errors.OperationFailure("The chosen file did not read back", { dispatch: "sent" });
    return file;
  },
);
