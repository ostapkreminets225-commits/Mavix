import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Circle, CircleCheck, CircleDot } from "lucide-react";
import type { ToolItem } from "../../chat";
import { openFile } from "../../actions";
import { handleMarkdownClick, renderMarkdown } from "../../markdown";
import { relativePath } from "../../util";
import { isImagePath } from "../../images";
import { LocalImage, cleanImagePath, findImages, imageUrl, withoutImages, zoomImage, type ImageRef } from "./LocalImage";

type Input = Record<string, any>;

const LABELS: Record<string, string> = {
  Bash: "Bash",
  PowerShell: "PowerShell",
  Read: "Read",
  Write: "Write",
  Edit: "Edit",
  MultiEdit: "Edit",
  NotebookEdit: "Notebook",
  Grep: "Grep",
  Glob: "Glob",
  WebFetch: "Fetch",
  WebSearch: "Web Search",
  Task: "Agent",
  Agent: "Agent",
  TodoWrite: "Задачі",
  Skill: "Skill",
  ExitPlanMode: "План",
  AskUserQuestion: "Питання",
  ToolSearch: "Tool Search",
};

export function toolLabel(name: string): string {
  if (LABELS[name]) return LABELS[name];
  const mcp = name.match(/^mcp__(.+?)__(.+)$/);
  if (mcp) return `${mcp[1].replace(/^claude_ai_/, "")} · ${mcp[2]}`;
  return name;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function Markdown({ source, className = "" }: { source: string; className?: string }) {
  const html = useMemo(() => renderMarkdown(source), [source]);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = box.current;
    if (!root) return;
    let alive = true;
    root.querySelectorAll<HTMLImageElement>("img[data-local]").forEach((img) => {
      const path = img.dataset.local ?? "";
      imageUrl(path).then(
        (url) => {
          if (!alive) return;
          img.src = url;
          img.classList.remove("pending");
        },
        () => {
          if (!alive) return;
          const note = document.createElement("span");
          note.className = "md-img-missing";
          note.textContent = `Не вдалося відкрити картинку: ${cleanImagePath(path)}`;
          img.replaceWith(note);
        },
      );
    });
    return () => {
      alive = false;
    };
  }, [html]);
  const onClick = (event: React.MouseEvent) => {
    const target = event.target as HTMLElement;
    if (target instanceof HTMLImageElement && target.src && !target.classList.contains("pending")) {
      zoomImage(target.src, target.alt);
      return;
    }
    handleMarkdownClick(event);
  };
  return <div ref={box} className={`md chat-md ${className}`} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
}

function Shots({ images, chosen = "", labels }: { images: ImageRef[]; chosen?: string; labels?: string[] }) {
  return (
    <div className="ct-shots">
      {images.map((image, i) => {
        const label = labels?.[i] ?? image.alt;
        return (
          <figure key={image.path} className={`ct-shot${chosen && label === chosen ? " chosen" : ""}`}>
            <LocalImage image={image} />
            {label && <figcaption>{label}</figcaption>}
          </figure>
        );
      })}
    </div>
  );
}

function askShots(question: Input) {
  const options: Input[] = Array.isArray(question.options) ? question.options : [];
  const images: ImageRef[] = [];
  const labels: string[] = [];
  for (const option of options) {
    for (const image of [...findImages(text(option.preview)), ...findImages(text(option.description))]) {
      images.push(image);
      labels.push(text(option.label));
    }
  }
  return { own: findImages(text(question.question)), images, labels };
}

function AskSummary({ input, result, error }: { input: Input; result: string | null; error: boolean }) {
  const questions: Input[] = Array.isArray(input.questions) ? input.questions : [];
  const shots = questions.map(askShots);
  const visual = shots.some((s) => s.own.length || s.images.length);
  if (!visual) return <IoBox input={questions.map((q) => text(q.question)).join("\n")} output={result} error={error} />;
  return (
    <>
      {questions.map((q, index) => {
        const { own, images, labels } = shots[index];
        const chosen = labels.find((label) => result?.includes(`="${label}"`)) ?? "";
        return (
          <div key={index} className="ct-ask">
            <div className="ct-ask-q">{withoutImages(text(q.question))}</div>
            {own.length > 0 && <Shots images={own} />}
            {images.length > 0 && <Shots images={images} labels={labels} chosen={chosen} />}
          </div>
        );
      })}
      <IoBox output={result} error={error} />
    </>
  );
}

function Clip({ body, lines, tone = "" }: { body: string; lines: number; tone?: string }) {
  const [full, setFull] = useState(false);
  const all = useMemo(() => body.replace(/\s+$/, "").split("\n"), [body]);
  const shown = full ? all : all.slice(0, lines);
  return (
    <div className={`ct-code ${tone}`}>
      <pre>{shown.join("\n")}</pre>
      {all.length > lines && (
        <button className="ct-more" onClick={() => setFull(!full)}>
          {full ? "Згорнути" : `Ще ${all.length - lines} рядк.`}
        </button>
      )}
    </div>
  );
}

function IoBox({ input, output, error, outLines = 8 }: { input?: string; output?: string | null; error?: boolean; outLines?: number }) {
  const hasOut = typeof output === "string" && output.trim().length > 0;
  if (!input && !hasOut) return null;
  return (
    <div className="ct-box">
      {input ? (
        <div className="ct-row">
          <span className="ct-label">IN</span>
          <Clip body={input} lines={6} />
        </div>
      ) : null}
      {hasOut ? (
        <div className="ct-row">
          <span className="ct-label">OUT</span>
          <Clip body={output!} lines={outLines} tone={error ? "err" : ""} />
        </div>
      ) : null}
    </div>
  );
}

function DiffBox({ edits }: { edits: { before: string; after: string }[] }) {
  const [full, setFull] = useState(false);
  const rows = useMemo(() => {
    const out: { sign: "-" | "+"; line: string }[] = [];
    for (const edit of edits) {
      if (edit.before) edit.before.split("\n").forEach((line) => out.push({ sign: "-", line }));
      edit.after.split("\n").forEach((line) => out.push({ sign: "+", line }));
    }
    return out;
  }, [edits]);
  const limit = 14;
  const shown = full ? rows : rows.slice(0, limit);
  return (
    <div className="ct-box ct-diff">
      {shown.map((row, i) => (
        <div key={i} className={`ct-diff-line ${row.sign === "-" ? "del" : "add"}`}>
          <span className="ct-diff-sign">{row.sign}</span>
          <span className="ct-diff-text">{row.line || " "}</span>
        </div>
      ))}
      {rows.length > limit && (
        <button className="ct-more" onClick={() => setFull(!full)}>
          {full ? "Згорнути" : `Ще ${rows.length - limit} рядк.`}
        </button>
      )}
    </div>
  );
}

function Todos({ todos }: { todos: Input[] }) {
  return (
    <div className="ct-todos">
      {todos.map((todo, i) => {
        const status = text(todo.status);
        const Icon = status === "completed" ? CircleCheck : status === "in_progress" ? CircleDot : Circle;
        return (
          <div key={i} className={`ct-todo ${status}`}>
            <Icon size={13} strokeWidth={1.8} />
            <span>{status === "in_progress" ? text(todo.activeForm) || text(todo.content) : text(todo.content)}</span>
          </div>
        );
      })}
    </div>
  );
}

type Spec = { target?: string; path?: string; note?: string; body?: ReactNode };

function countLines(result: string | null): number {
  if (!result) return 0;
  return result.replace(/\s+$/, "").split("\n").length;
}

function describe(item: ToolItem, cwd: string): Spec {
  const input = item.input as Input;
  const result = item.result;
  const error = item.isError;
  const shortPath = (p: string) => (cwd ? relativePath(cwd, p) : p);
  switch (item.name) {
    case "Bash":
    case "PowerShell":
      return { target: text(input.description), body: <IoBox input={text(input.command)} output={result} error={error} /> };
    case "Read": {
      const path = text(input.file_path);
      if (!error && result !== null && isImagePath(path)) {
        return { target: shortPath(path), path, note: "зображення", body: <Shots images={[{ alt: "", path }]} /> };
      }
      const lines = countLines(result);
      return { target: shortPath(path), path, note: error ? "" : lines ? `${lines} рядк.` : "", body: error ? <IoBox output={result} error /> : null };
    }
    case "Write": {
      const path = text(input.file_path);
      return { target: shortPath(path), path, body: error ? <IoBox output={result} error /> : <DiffBox edits={[{ before: "", after: text(input.content) }]} /> };
    }
    case "Edit": {
      const path = text(input.file_path);
      return {
        target: shortPath(path),
        path,
        body: (
          <>
            <DiffBox edits={[{ before: text(input.old_string), after: text(input.new_string) }]} />
            {error && <IoBox output={result} error />}
          </>
        ),
      };
    }
    case "MultiEdit": {
      const path = text(input.file_path);
      const edits = Array.isArray(input.edits) ? input.edits.map((e: Input) => ({ before: text(e.old_string), after: text(e.new_string) })) : [];
      return { target: shortPath(path), path, body: <DiffBox edits={edits} /> };
    }
    case "Grep":
      return { target: text(input.pattern), note: text(input.path) ? shortPath(text(input.path)) : text(input.glob), body: <IoBox output={result} error={error} outLines={6} /> };
    case "Glob":
      return { target: text(input.pattern), note: text(input.path) ? shortPath(text(input.path)) : "", body: <IoBox output={result} error={error} outLines={6} /> };
    case "WebSearch":
      return { target: text(input.query), body: <IoBox output={result} error={error} outLines={5} /> };
    case "WebFetch":
      return { target: text(input.url), body: <IoBox output={result} error={error} outLines={5} /> };
    case "Task":
    case "Agent": {
      const steps = item.subagentSteps ? `${item.subagentSteps} крок.${item.result === null && item.subagentLast ? ` · ${toolLabel(item.subagentLast)}` : ""}` : "";
      return {
        target: text(input.description),
        note: [text(input.subagent_type), steps].filter(Boolean).join(" · "),
        body: result ? <IoBox output={result} error={error} outLines={8} /> : null,
      };
    }
    case "TodoWrite":
      return { body: Array.isArray(input.todos) ? <Todos todos={input.todos} /> : null };
    case "Skill":
      return { target: text(input.skill) || text(input.command), body: error ? <IoBox output={result} error /> : null };
    case "ExitPlanMode":
      return {
        body: (
          <div className="ct-box ct-plan">
            <Markdown source={text(input.plan)} />
          </div>
        ),
      };
    case "AskUserQuestion":
      return { body: <AskSummary input={input} result={result} error={error} /> };
    default: {
      const json = Object.keys(input).length ? JSON.stringify(input, null, 2) : "";
      return { body: <IoBox input={json} output={result} error={error} outLines={6} /> };
    }
  }
}

export const ToolView = memo(function ToolView({ item, cwd }: { item: ToolItem; cwd: string }) {
  const state = item.result === null ? "run" : item.isError ? "err" : "ok";
  const spec = describe(item, cwd);
  return (
    <div className={`ci ci-tool ${state}`}>
      <div className="ct-head">
        <span className="ct-name">{toolLabel(item.name)}</span>
        {spec.target &&
          (spec.path ? (
            <button className="ct-target link" onClick={() => openFile(spec.path!)} title={spec.path}>
              {spec.target}
            </button>
          ) : (
            <span className="ct-target" title={spec.target}>
              {spec.target}
            </span>
          ))}
        {spec.note && <span className="ct-note">{spec.note}</span>}
      </div>
      {spec.body}
    </div>
  );
});
