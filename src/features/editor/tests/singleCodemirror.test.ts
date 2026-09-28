import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { unifiedMergeView } from "@codemirror/merge";
import { basicSetup } from "codemirror";

import { changeGutter } from "../changeGutter";
import { editorTheme, languageFor } from "../codemirror";

/**
 * El editor se arma con extensiones de una docena de paquetes de CodeMirror, y todos
 * tienen que ver EL MISMO `@codemirror/state`: una segunda copia instalada (pasó en la
 * 1.8.6, al actualizar `state` y `view` sin que los demás paquetes las siguieran) hace que
 * abrir cualquier archivo tire "Unrecognized extension value in extension set". Por eso
 * `package.json` las fija con `overrides`; esto avisa si vuelve a pasar, antes del release.
 */
describe("una sola copia de CodeMirror", () => {
  it("el estado del editor acepta todas sus extensiones", async () => {
    const extensions = [
      basicSetup,
      changeGutter({ before: "", revert: "", close: "", added: "" }),
      keymap.of([indentWithTab]),
      editorTheme(true),
      await languageFor("src/app.ts"),
      await languageFor("README.md"),
      EditorView.updateListener.of(() => {}),
      unifiedMergeView({ original: "a" }),
    ];
    expect(() => EditorState.create({ doc: "const a = 1;", extensions })).not.toThrow();
  });
});
