import { PostgreSQL, sql } from "@codemirror/lang-sql";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { useEffect, useImperativeHandle, useRef, type Ref } from "react";
import { catalogCompletionSource, type SqlCompletion } from "./sql-completion";
import styles from "./QueryWorkspace.module.css";

export interface QueryEditorHandle {
  /** Inserts text at the cursor, replacing the selection. */
  insert(text: string): void;
}

export interface QueryEditorProps {
  readonly ref?: Ref<QueryEditorHandle>;
  readonly value: string;
  readonly label: string;
  /** Tables and columns of the lake to suggest while typing. Without it, only SQL keywords are completed. */
  readonly completion?: SqlCompletion | null;
  onChange(value: string): void;
  onRun(): void;
}

export function QueryEditor({ ref, value, label, completion = null, onChange, onRun }: QueryEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const handlers = useRef({ onChange, onRun });
  handlers.current = { onChange, onRun };
  // Read through a ref: the catalog arriving late must not rebuild the editor and lose the cursor.
  const completionRef = useRef(completion);
  completionRef.current = completion;

  useEffect(() => {
    if (!hostRef.current) return;
    const view = new EditorView({
      parent: hostRef.current,
      doc: value,
      extensions: [
        keymap.of([{ key: "Mod-Enter", run: () => (handlers.current.onRun(), true) }]),
        basicSetup,
        sql({ dialect: PostgreSQL, upperCaseKeywords: true }),
        PostgreSQL.language.data.of({ autocomplete: catalogCompletionSource(() => completionRef.current) }),
        EditorView.contentAttributes.of({ "aria-label": label }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) handlers.current.onChange(update.state.doc.toString());
        }),
      ],
    });
    viewRef.current = view;
    return () => view.destroy();
    // The editor owns its document; external changes are synced by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [label]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === value) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
    });
  }, [value]);

  useImperativeHandle(
    ref,
    () => ({
      insert(text) {
        const view = viewRef.current;
        if (!view) return;
        view.dispatch(view.state.replaceSelection(text));
        view.focus();
      },
    }),
    [],
  );

  return <div ref={hostRef} className={styles.editor} />;
}
