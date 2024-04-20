import type { Denops } from "https://deno.land/x/lspoints@v0.0.7/deps/denops.ts";
import {
  BaseExtension,
  type Lspoints,
} from "https://deno.land/x/lspoints@v0.0.7/interface.ts";
import { LSP, LSPTypes } from "https://deno.land/x/lspoints@v0.0.7/deps/lsp.ts";
import { is, u } from "https://deno.land/x/lspoints@v0.0.7/deps/unknownutil.ts";
import * as batch from "https://deno.land/x/denops_std@v6.4.0/batch/mod.ts";
import { fromFileUrl } from "https://deno.land/std@0.223.0/path/from_file_url.ts";

type VimFuncref = unknown;
type CopilotTriggerKind = /* Invoked */ 0 | /* Automatic */ 1;
type Params = {
  context: {
    triggerKind: CopilotTriggerKind;
  };
  formattingOptions: {
    insertSpaces: boolean;
    tabSize: number;
  };
  position: LSP.Position;
  textDocument:
    | LSP.VersionedTextDocumentIdentifier
    | { uri: number };
};
type Target = [bufnr: number, changedtick: number, lnum: number, col: number];
type Candidate = {
  command: LSP.Command;
  range: LSP.Range;
  insertText: string;
};
type Agent<T extends string> = {
  agent_id: number;
  id: number;
  method: T;
  params: Params;
  result: {
    completions: Candidate[];
  };
  status: string;
  waiting: unknown;
  Agent: VimFuncref;
  Wait: VimFuncref;
  Await: VimFuncref;
  Cancel: VimFuncref;
};
type OriginalCopilotContext = {
  choice?: number;
  cycling?: Agent<"getCompletionsCycling">;
  cycling_callbacks?: VimFuncref[];
  first: Agent<"getCompletions">;
  shown_choices?: Record<string, true>;
  params: Params;
  suggestions?: Candidate[];
};

type CopilotContext = {
  candidates: Candidate[];
  selected: number;
  params: Params;
};

type ExtmarkData = {
  id: number;
  virt_text: ([string] | [string, string])[];
  virt_text_pos: string;
  hl_mode: string;
  virt_lines?: ([string] | [string, string])[][];
};

const isPosition: u.Predicate<LSP.Position> = is.ObjectOf({
  line: is.Number,
  character: is.Number,
});
const isRange: u.Predicate<LSP.Range> = is.ObjectOf({
  start: isPosition,
  end: isPosition,
});
const isVersionedTextDocumentIdentifier: u.Predicate<
  LSP.VersionedTextDocumentIdentifier
> = is.ObjectOf({
  uri: is.String,
  version: is.Number,
});
const triggerKind = {
  Invoked: 0,
  Automatic: 1,
} as const satisfies Record<string, CopilotTriggerKind>;
const isTriggerKind: u.Predicate<CopilotTriggerKind> = is.LiteralOneOf([
  triggerKind.Invoked,
  triggerKind.Automatic,
]);
const isCommand: u.Predicate<LSP.Command> = is.ObjectOf({
  title: is.String,
  command: is.String,
  arguments: is.OptionalOf(is.Any),
});
const isCandidate: u.Predicate<Candidate> = is.ObjectOf({
  command: isCommand,
  range: isRange,
  insertText: is.String,
});
const isParams: u.Predicate<Params> = is.ObjectOf({
  context: is.ObjectOf({
    triggerKind: isTriggerKind,
  }),
  formattingOptions: is.ObjectOf({
    insertSpaces: is.Boolean,
    tabSize: is.Number,
  }),
  position: isPosition,
  textDocument: is.UnionOf([
    isVersionedTextDocumentIdentifier,
    is.ObjectOf({ uri: is.Number }),
  ]),
});

async function makeParamsAndTarget(denops: Denops): Promise<[Params, Target]> {
  const [uri, changedtick, insertSpaces, shiftWidth, line, lnum, col, mode] =
    await batch
      .collect(
        denops,
        (denops) => [
          denops.call("bufnr", ""),
          denops.call("getbufvar", "", "changedtick", 0),
          denops.eval("&expandtab"),
          denops.call("shiftwidth"),
          denops.call("getline", "."),
          denops.call("line", "."),
          denops.call("col", "."),
          denops.call("mode"),
        ],
      ) as [number, number, number, number, string, number, number, string];
  const position: LSP.Position = {
    line: lnum - 1,
    character: line
      .substring(0, col - (/^[iR]/.test(mode) || !line ? 1 : 0))
      .length,
  };
  const params: Params = {
    context: { triggerKind: triggerKind.Automatic },
    formattingOptions: {
      insertSpaces: !!insertSpaces,
      tabSize: shiftWidth,
    },
    position,
    textDocument: { uri },
  };
  const target: Target = [uri, changedtick, lnum, col];
  return [params, target];
}

async function getCurrentCandidate(denops: Denops): Promise<Candidate | null> {
  const [mode, context, lnum] = await batch.collect(
    denops,
    (denops) => [
      denops.call("mode"),
      denops.call("getbufvar", "", "__copilot", null),
      denops.call("line", "."),
    ],
  ) as [string, CopilotContext | null, number];
  if (!/^[iR]/.test(mode) || !context || !context.candidates) {
    return null;
  }
  const selected = context.candidates[context.selected];
  if (
    !selected?.range || selected.range.start.line !== lnum - 1 ||
    selected.range.start.character !== 0
  ) {
    return null;
  }
  return selected;
}

async function getDisplayAdjustment(
  denops: Denops,
  candidate: Candidate | null,
): Promise<[text: string, outdent: number, toDelete: number]> {
  if (!candidate) {
    return ["", 0, 0];
  }
  const [line, col] = await batch.collect(
    denops,
    (denops) => [
      denops.call("getline", "."),
      denops.call("col", "."),
    ],
  ) as [string, number];
  const offset = col - 1;
  const selectedText = line.substring(0, candidate.range.start.character) +
    candidate.insertText.replace(/\n*$/, "");
  const typed = line.substring(0, offset);
  const endOffset = line.length > candidate.range.end.character
    ? line.length
    : candidate.range.end.character;
  const toDelete = line.substring(offset, endOffset + 1);
  if (/^\s*$/.test(typed)) {
    const leading = selectedText.match(/^\s*/)?.[0] ?? "";
    const unindented = selectedText.substring(leading.length);
    if (
      typed.substring(0, leading.length) === leading && unindented !== toDelete
    ) {
      return [unindented, typed.length - leading.length, toDelete.length];
    }
  } else if (typed === selectedText.substring(0, offset)) {
    return [selectedText.substring(offset), 0, toDelete.length];
  }
  return ["", 0, 0];
}

const hlgroup = "CopilotSuggestion";
const annotHlgroup = "CopilotAnnotation";

async function drawPreview(denops: Denops, lspoints: Lspoints): Promise<void> {
  const candidate = await getCurrentCandidate(denops);
  const text = candidate?.insertText.split("\n");
  await clearPreview(denops);
  if (!candidate || !text) {
    return;
  }
  const annot = "";
  const [col, lnum, colEnd] = await batch.collect(
    denops,
    (denops) => [
      denops.call("col", "."),
      denops.call("line", "."),
      denops.call("col", "$"),
    ],
  ) as [number, number, number];
  const newlinePos = candidate.insertText.indexOf("\n");
  text[0] = candidate.insertText.substring(
    col - 1,
    newlinePos > -1 ? newlinePos : undefined,
  );
  switch (denops.meta.host) {
    case "nvim": {
      const ns = await denops.call(
        "nvim_create_namespace",
        "lspoints-extension-copilot",
      );
      const data: ExtmarkData = {
        id: 1,
        virt_text: [[text[0], hlgroup]],
        virt_text_pos: "overlay",
        hl_mode: "combine",
      };
      if (text.length > 1) {
        data.virt_lines = text.slice(1).map((line) => [[line, hlgroup]]);
        if (annot) {
          data.virt_lines[-1]?.push([" "], [annot, annotHlgroup]);
        }
      } else if (annot) {
        data.virt_text.push([" "], [annot, annotHlgroup]);
      }
      await denops.call("nvim_buf_set_extmark", 0, ns, lnum - 1, col - 1, data);
      break;
    }
    case "vim":
      await batch.batch(denops, async (denops) => {
        await denops.call("prop_add", lnum, col, {
          type: hlgroup,
          text: text[0],
        });
        for (const line of text.slice(1)) {
          await denops.call("prop_add", lnum, 0, {
            type: hlgroup,
            text_align: "below",
            text: line,
          });
        }
        if (annot) {
          await denops.call("prop_add", lnum, colEnd, {
            type: annotHlgroup,
            text: " " + annot,
          });
        }
      });
  }
  console.log({ candidate });
  await lspoints.notify("copilot", "textDocuemt/didShowCompletion", {
    item: candidate,
  });
}

async function clearPreview(denops: Denops): Promise<void> {
  switch (denops.meta.host) {
    case "nvim": {
      const ns = await denops.call(
        "nvim_create_namespace",
        "lspoints-extension-copilot",
      );
      await denops.call("nvim_buf_del_extmark", 0, ns, 1);
      break;
    }
    case "vim":
      await denops.call("prop_remove", { type: hlgroup, all: true });
      await denops.call("prop_remove", { type: annotHlgroup, all: true });
      break;
  }
}

export class Extension extends BaseExtension {
  override initialize(denops: Denops, lspoints: Lspoints): Promise<void> {
    const initializationOptions = {
      editorInfo: {
        name: denops.meta.host === "nvim" ? "Neovim" : "Vim",
        version: denops.meta.version,
      },
      editorPluginInfo: {
        name: "lspoints-extension-copilot",
        version: "0.0.1",
      },
    };
    // TODO: Provide a way to configure these settings
    const settings = {
      http: { proxy: null, proxyStrictSSL: null },
      "github-enterprise": { uri: null },
      enableAutoCompletions: true,
      disabledLanguages: [{ languageId: "." }],
    };

    const entrypoint = fromFileUrl(import.meta.resolve("../../dist/agent.js"));
    lspoints.settings.patch({
      startOptions: {
        copilot: {
          cmd: ["node", entrypoint],
          initializationOptions,
          settings,
        },
      },
    });

    lspoints.defineCommands("copilot", {
      suggest: async () => {
        const [params, target] = await makeParamsAndTarget(denops);
        const client = lspoints.getClient("copilot");
        if (!client) {
          return;
        }
        // Sync textDocument
        if (is.Number(params.textDocument.uri)) {
          const bufnr = params.textDocument.uri;
          if (!client.isAttached(bufnr)) {
            return;
          }
          console.log("sync textDocument", bufnr);
          params.textDocument = {
            uri: client.getUriFromBufNr(bufnr),
            version: client.getDocumentVersion(bufnr),
          } satisfies LSP.VersionedTextDocumentIdentifier;
        }
        const { items } = u.ensure(
          await lspoints.request(
            "copilot",
            "textDocument/inlineCompletion",
            params,
          ),
          is.ObjectOf({ items: is.ArrayOf(isCandidate) }),
        );
        await denops.cmd("let b:__copilot = context", {
          context: {
            candidates: items,
            selected: 0,
            params,
          } satisfies CopilotContext,
        });
        await drawPreview(denops, lspoints);
      },
      drawPreview: async () => {
        await drawPreview(denops, lspoints);
      },
      clearPreview: async () => {
        await clearPreview(denops);
      },
      notifyDidFocus: async (bufnr) => {
        const client = lspoints.getClient("copilot");
        if (!client || !is.Number(bufnr) || !client.isAttached(bufnr)) {
          return;
        }
        await lspoints.notify("copilot", "textDocument/didFocus", {
          textDocument: { uri: client.getUriFromBufNr(bufnr) },
        });
      },
    });

    return Promise.resolve();
  }
}
