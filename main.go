package main

import (
	"encoding/json"
	"encoding/xml"
	"fmt"
	"html"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	defaultPort = "8080"
	mapsDir     = "maps"
	version     = "1.0.1"
)

// --- JSON models used by the UI/API ---

type JSONMap struct {
	Version string    `json:"version"`
	Root    *JSONNode `json:"root"`
}

type JSONNode struct {
	ID       string      `json:"id"`
	Text     string      `json:"text"`
	Note     string      `json:"note"`
	Folded   bool        `json:"folded"`
	Position string      `json:"position,omitempty"`
	Links    []string    `json:"links"` // destination node IDs (arrow links)
	Children []*JSONNode `json:"children"`
}

// --- XML models for Freeplane .mm format ---

type XMLMap struct {
	XMLName xml.Name `xml:"map"`
	Version string   `xml:"version,attr"`
	Node    *XMLNode `xml:"node"`
}

type XMLNode struct {
	Text        string           `xml:"TEXT,attr"`
	ID          string           `xml:"ID,attr"`
	Created     string           `xml:"CREATED,attr,omitempty"`
	Modified    string           `xml:"MODIFIED,attr,omitempty"`
	Folded      string           `xml:"FOLDED,attr,omitempty"`
	Position    string           `xml:"POSITION,attr,omitempty"`
	ArrowLinks  []XMLArrowLink   `xml:"arrowlink"`
	RichContent []XMLRichContent `xml:"richcontent"`
	Children    []*XMLNode       `xml:"node"`
}

type XMLArrowLink struct {
	Destination string `xml:"DESTINATION,attr"`
	Color       string `xml:"COLOR,attr,omitempty"`
}

type XMLRichContent struct {
	Type string `xml:"TYPE,attr"`
	// We capture the inner HTML as raw for simplicity when reading
	Inner string `xml:",innerxml"`
}

func main() {
	if err := os.MkdirAll(mapsDir, 0755); err != nil {
		log.Fatalf("cannot create maps dir: %v", err)
	}

	mux := http.NewServeMux()

	// Static UI
	mux.HandleFunc("/", serveIndex)
	mux.Handle("/static/", http.StripPrefix("/static/", http.FileServer(http.Dir("static"))))

	// API
	mux.HandleFunc("/api/maps", handleMaps)
	mux.HandleFunc("/api/map/", handleMap)
	mux.HandleFunc("/api/download/", handleDownload)
	mux.HandleFunc("/api/upload", handleUpload)

	addr := ":" + defaultPort
	if p := os.Getenv("PORT"); p != "" {
		addr = ":" + p
	}

	fmt.Printf("Freeplane Web Editor running at http://localhost%s\n", addr)
	fmt.Printf("Maps directory: %s/\n", mapsDir)
	log.Fatal(http.ListenAndServe(addr, mux))
}

func serveIndex(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	http.ServeFile(w, r, "static/index.html")
}

// GET /api/maps  → list of .mm files
// POST /api/maps → create new map { "name": "foo" }
func handleMaps(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		listMaps(w)
	case http.MethodPost:
		createMap(w, r)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func listMaps(w http.ResponseWriter) {
	entries, err := os.ReadDir(mapsDir)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	names := []string{}
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(strings.ToLower(e.Name()), ".mm") {
			names = append(names, strings.TrimSuffix(e.Name(), ".mm"))
		}
	}
	writeJSON(w, names)
}

func createMap(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Name == "" {
		http.Error(w, "name required", 400)
		return
	}
	name := sanitizeName(req.Name)
	path := filepath.Join(mapsDir, name+".mm")
	if _, err := os.Stat(path); err == nil {
		http.Error(w, "map already exists", 409)
		return
	}

	root := &JSONNode{
		ID:       newID(),
		Text:     name,
		Note:     "",
		Links:    []string{},
		Children: []*JSONNode{},
	}
	jm := &JSONMap{Version: version, Root: root}
	if err := saveJSONMap(path, jm); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	writeJSON(w, jm)
}

// GET  /api/map/{name}  → JSON tree
// PUT  /api/map/{name}  → save JSON tree
// DELETE /api/map/{name}
func handleMap(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(r.URL.Path, "/api/map/")
	name = sanitizeName(name)
	if name == "" {
		http.Error(w, "name required", 400)
		return
	}
	path := filepath.Join(mapsDir, name+".mm")

	switch r.Method {
	case http.MethodGet:
		jm, err := loadJSONMap(path)
		if err != nil {
			if os.IsNotExist(err) {
				http.Error(w, "not found", 404)
			} else {
				http.Error(w, err.Error(), 500)
			}
			return
		}
		writeJSON(w, jm)

	case http.MethodPut:
		var jm JSONMap
		if err := json.NewDecoder(r.Body).Decode(&jm); err != nil {
			http.Error(w, "invalid json: "+err.Error(), 400)
			return
		}
		if jm.Root == nil {
			http.Error(w, "root required", 400)
			return
		}
		if err := saveJSONMap(path, &jm); err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		w.WriteHeader(http.StatusNoContent)

	case http.MethodDelete:
		if err := os.Remove(path); err != nil {
			if os.IsNotExist(err) {
				http.Error(w, "not found", 404)
			} else {
				http.Error(w, err.Error(), 500)
			}
			return
		}
		w.WriteHeader(http.StatusNoContent)

	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func handleDownload(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(r.URL.Path, "/api/download/")
	name = sanitizeName(name)
	path := filepath.Join(mapsDir, name+".mm")
	data, err := os.ReadFile(path)
	if err != nil {
		http.Error(w, "not found", 404)
		return
	}
	w.Header().Set("Content-Type", "application/x-freemind")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s.mm"`, name))
	w.Write(data)
}

// POST /api/upload  multipart form field "file" containing a .mm file
// Optional form field "name" to override the stored map name.
// Optional form field "overwrite" = "1" to replace an existing map.
func handleUpload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if err := r.ParseMultipartForm(10 << 20); err != nil { // 10 MB max
		http.Error(w, "invalid multipart form: "+err.Error(), 400)
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		http.Error(w, "file required", 400)
		return
	}
	defer file.Close()

	data, err := io.ReadAll(file)
	if err != nil {
		http.Error(w, "read error: "+err.Error(), 500)
		return
	}

	// Validate it is parseable Freeplane/FreeMind XML
	var xm XMLMap
	if err := xml.Unmarshal(data, &xm); err != nil {
		http.Error(w, "not a valid .mm file: "+err.Error(), 400)
		return
	}
	if xm.Node == nil {
		http.Error(w, "not a valid .mm file: missing root node", 400)
		return
	}

	// Determine name: form field, else filename without .mm
	name := r.FormValue("name")
	if name == "" {
		name = header.Filename
	}
	name = sanitizeName(name)
	if name == "" {
		http.Error(w, "could not determine map name", 400)
		return
	}

	path := filepath.Join(mapsDir, name+".mm")
	if _, err := os.Stat(path); err == nil {
		if r.FormValue("overwrite") != "1" {
			http.Error(w, "map already exists (send overwrite=1 to replace)", 409)
			return
		}
	}

	// Store the original XML (preserves more Freeplane features than re-serializing)
	if err := os.WriteFile(path, data, 0644); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}

	// Return the parsed JSON tree so the UI can open it immediately
	jm := &JSONMap{
		Version: xm.Version,
		Root:    xmlNodeToJSON(xm.Node),
	}
	if jm.Version == "" {
		jm.Version = version
	}
	writeJSON(w, map[string]any{
		"name": name,
		"map":  jm,
	})
}

// ---------- conversion helpers ----------

func loadJSONMap(path string) (*JSONMap, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var xm XMLMap
	if err := xml.Unmarshal(data, &xm); err != nil {
		return nil, fmt.Errorf("xml parse: %w", err)
	}
	if xm.Node == nil {
		return nil, fmt.Errorf("no root node")
	}
	return &JSONMap{
		Version: xm.Version,
		Root:    xmlNodeToJSON(xm.Node),
	}, nil
}

func saveJSONMap(path string, jm *JSONMap) error {
	if jm.Version == "" {
		jm.Version = version
	}
	xm := &XMLMap{
		Version: jm.Version,
		Node:    jsonNodeToXML(jm.Root),
	}
	out, err := xml.MarshalIndent(xm, "", "  ")
	if err != nil {
		return err
	}
	// Add XML declaration
	full := append([]byte(xml.Header), out...)
	return os.WriteFile(path, full, 0644)
}

func xmlNodeToJSON(n *XMLNode) *JSONNode {
	jn := &JSONNode{
		ID:       n.ID,
		Text:     n.Text,
		Folded:   n.Folded == "true",
		Position: n.Position,
		Links:    make([]string, 0, len(n.ArrowLinks)),
		Children: make([]*JSONNode, 0, len(n.Children)),
	}
	for _, al := range n.ArrowLinks {
		if al.Destination != "" {
			jn.Links = append(jn.Links, al.Destination)
		}
	}
	// Extract note from richcontent
	for _, rc := range n.RichContent {
		if strings.EqualFold(rc.Type, "NOTE") {
			jn.Note = extractTextFromHTML(rc.Inner)
			break
		}
	}
	for _, c := range n.Children {
		jn.Children = append(jn.Children, xmlNodeToJSON(c))
	}
	return jn
}

func jsonNodeToXML(n *JSONNode) *XMLNode {
	if n == nil {
		return nil
	}
	now := strconv.FormatInt(time.Now().UnixMilli(), 10)
	xn := &XMLNode{
		Text:       n.Text,
		ID:         n.ID,
		Created:    now, // Freeplane accepts; we overwrite on every save for simplicity
		Modified:   now,
		Position:   n.Position,
		ArrowLinks: make([]XMLArrowLink, 0, len(n.Links)),
		Children:   make([]*XMLNode, 0, len(n.Children)),
	}
	if n.Folded {
		xn.Folded = "true"
	}
	for _, dest := range n.Links {
		if dest != "" {
			xn.ArrowLinks = append(xn.ArrowLinks, XMLArrowLink{
				Destination: dest,
				Color:       "#0000ff",
			})
		}
	}
	if n.Note != "" {
		// Simple XHTML note
		body := "<p>" + html.EscapeString(n.Note) + "</p>"
		// Replace newlines with <br/> for multi-line notes
		body = strings.ReplaceAll(body, "\n", "<br/>")
		xn.RichContent = []XMLRichContent{{
			Type:  "NOTE",
			Inner: "\n    <html>\n      <head></head>\n      <body>" + body + "</body>\n    </html>\n  ",
		}}
	}
	for _, c := range n.Children {
		xn.Children = append(xn.Children, jsonNodeToXML(c))
	}
	return xn
}

var (
	brRe  = regexp.MustCompile(`(?i)<br\s*/?>`)
	pRe   = regexp.MustCompile(`(?i)</p>\s*<p[^>]*>`)
	tagRe = regexp.MustCompile(`<[^>]*>`)
)

func extractTextFromHTML(s string) string {
	// Preserve some structure: <br> and </p><p> → newline, then strip remaining tags
	s = brRe.ReplaceAllString(s, "\n")
	s = pRe.ReplaceAllString(s, "\n")
	s = tagRe.ReplaceAllString(s, "")
	s = html.UnescapeString(s)
	// Normalize whitespace but keep intentional newlines
	lines := strings.Split(s, "\n")
	for i, line := range lines {
		lines[i] = strings.TrimSpace(line)
	}
	return strings.TrimSpace(strings.Join(lines, "\n"))
}

func newID() string {
	return "ID_" + strconv.FormatInt(time.Now().UnixNano(), 36)
}

func sanitizeName(name string) string {
	name = filepath.Base(name)
	name = strings.TrimSuffix(name, ".mm")
	// keep only safe chars
	var b strings.Builder
	for _, r := range name {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' || r == ' ' {
			b.WriteRune(r)
		}
	}
	return strings.TrimSpace(b.String())
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	enc.Encode(v)
}
