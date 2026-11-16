import { useEffect, useMemo, useRef, useState } from "react";
import { Search, LoaderCircle } from "lucide-react";
import { api, errorText, type SearchHit } from "../../ipc";
import { useActiveWorkspace } from "../../store";
import { openFile } from "../../actions";
import { SideHeader } from "../Sidebar";
import { FileIcon } from "../FileIcon";
import { basename, joinPath } from "../../util";

export function SearchView() {
  const ws = useActiveWorkspace();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
  }, []);
  const run = async () => {
    if (!ws.root || !query.trim()) return;
    setBusy(true);
    setError(null);
    try {
      setHits(await api.search(ws.root, query.trim()));
      setSearched(query.trim());
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const grouped = useMemo(() => {
    const map = new Map<string, SearchHit[]>();
    for (const hit of hits) map.set(hit.file, [...(map.get(hit.file) ?? []), hit]);
    return [...map.entries()];
  }, [hits]);
  const mark = (text: string) => {
    const index = text.toLowerCase().indexOf(searched.toLowerCase());
    if (index < 0 || !searched) return text;
    return (
      <>
        {text.slice(0, index)}
        <mark>{text.slice(index, index + searched.length)}</mark>
        {text.slice(index + searched.length)}
      </>
    );
  };
  return (
    <>
      <SideHeader title="Пошук" sub={ws.root ? ws.name : undefined} />
      <div className="side-pad">
        <div className="field-icon">
          <Search size={13} />
          <input
            ref={input}
            className="input"
            placeholder={ws.root ? "Текст у файлах проекту — Enter" : "Спершу відкрий проект"}
            value={query}
            disabled={!ws.root}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && run()}
          />
          {busy && <LoaderCircle size={13} className="spin" />}
        </div>
        {searched && !busy && (
          <div className="hint">
            {hits.length >= 2000 ? "2000+" : hits.length} збігів у {grouped.length} файлах
          </div>
        )}
        {error && <div className="hint error">{error}</div>}
      </div>
      <div className="side-scroll">
        {grouped.map(([file, list]) => (
          <div key={file} className="search-group">
            <div className="search-file" onClick={() => ws.root && openFile(joinPath(ws.root, file), list[0].line)}>
              <FileIcon name={basename(file)} />
              <span className="search-file-name">{basename(file)}</span>
              <span className="search-file-path">{file}</span>
              <span className="count">{list.length}</span>
            </div>
            {list.slice(0, 50).map((hit) => (
              <div key={hit.line} className="search-hit" onClick={() => ws.root && openFile(joinPath(ws.root, file), hit.line)}>
                <span className="line-no">{hit.line}</span>
                <span className="hit-text">{mark(hit.text)}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </>
  );
}
