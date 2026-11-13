// arcgo: what OpenArc reads from Go code, as JSON on stdout (stage0/src/lang/go.ts). Standard library only.
//
//	arcgo read <module root> <dir>...   the packages in those directories (relative to the module root): exported
//	                                    functions, methods and struct types, imports, test functions, and per function
//	                                    the test files that use it and its calls with literal arguments
//	arcgo funcs < file.go               the functions of one file (syntax only): name and body byte offsets
package main

import (
	"encoding/json"
	"fmt"
	"go/ast"
	"go/build"
	"go/constant"
	"go/importer"
	"go/parser"
	"go/token"
	"go/types"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
)

// Type is a parameter or result type as go.ts maps it to `.arc`: int float string bool slice ptr struct any native.
type Type struct {
	K      string  `json:"k"`
	Elem   *Type   `json:"elem,omitempty"`
	Name   string  `json:"name,omitempty"`
	Fields []Field `json:"fields,omitempty"`
	Text   string  `json:"text,omitempty"`
}

// Field is a struct field under its JSON name; unexported, embedded and `json:"-"` fields are left out.
type Field struct {
	Name     string `json:"name"`
	Type     *Type  `json:"type"`
	Optional bool   `json:"optional,omitempty"`
}

// Param: Go is the type as the generated harness declares it (other packages by their name, see Func.Imports).
type Param struct {
	Name string `json:"name"`
	Type *Type  `json:"type"`
	Go   string `json:"go"`
}

type Func struct {
	Name     string            `json:"name"` // F, or T.M for a method
	Recv     string            `json:"recv,omitempty"`
	Doc      []string          `json:"doc"`
	Params   []Param           `json:"params"`
	Variadic bool              `json:"variadic,omitempty"`
	Results  []*Type           `json:"results"`
	Error    bool              `json:"error,omitempty"` // the last result is an error (not in Results)
	Generic  bool              `json:"generic,omitempty"`
	Imports  map[string]string `json:"imports,omitempty"` // import path -> name, for the parameter types
	Decl     int               `json:"decl"`              // byte offset of `func`
	Start    int               `json:"start"`             // body: `{` ... `}` inclusive, byte offsets
	End      int               `json:"end"`
	Line     int               `json:"line"`
}

type File struct {
	Package string   `json:"package"`
	Imports []string `json:"imports"`
	Funcs   []Func   `json:"funcs"`
	Types   []*Type  `json:"types"` // exported struct types
	Tests   []string `json:"tests"` // Test functions (a _test.go file)
}

type Call struct {
	Args []any  `json:"args"`
	At   string `json:"at"`
}

type Use struct {
	Tests []string `json:"tests"`
	Calls []Call   `json:"calls"`
}

type Out struct {
	Module string           `json:"module"`
	Files  map[string]*File `json:"files"`
	Uses   map[string]*Use  `json:"uses"` // "<file>\x00<name>"
	Lits   map[string][]Call `json:"lits"` // "<file of the type>\x00<type>": its composite literals, as receivers
}

func main() {
	if len(os.Args) >= 2 && os.Args[1] == "funcs" {
		src, _ := io.ReadAll(os.Stdin)
		emit(funcs(src))
		return
	}
	if len(os.Args) < 3 || os.Args[1] != "read" {
		fmt.Fprintln(os.Stderr, "usage: arcgo read <module root> <dir>... | arcgo funcs < file.go")
		os.Exit(2)
	}
	emit(read(os.Args[2], os.Args[3:]))
}

func emit(v any) {
	b, err := json.Marshal(v)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	os.Stdout.Write(b)
}

type span struct {
	Name  string `json:"name"`
	Decl  int    `json:"decl"`
	Start int    `json:"start"`
	End   int    `json:"end"`
}

func funcs(src []byte) any {
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, "f.go", src, parser.SkipObjectResolution)
	if err != nil && f == nil {
		return map[string]any{"error": err.Error()}
	}
	out := []span{}
	for _, d := range f.Decls {
		fd, ok := d.(*ast.FuncDecl)
		if !ok || fd.Body == nil {
			continue
		}
		name := fd.Name.Name
		if r := recvName(fd); r != "" {
			name = r + "." + name
		}
		out = append(out, span{name, fset.Position(fd.Pos()).Offset, fset.Position(fd.Body.Lbrace).Offset, fset.Position(fd.Body.Rbrace).Offset + 1})
	}
	return map[string]any{"funcs": out}
}

func recvName(fd *ast.FuncDecl) string {
	if fd.Recv == nil || len(fd.Recv.List) == 0 {
		return ""
	}
	t := fd.Recv.List[0].Type
	for {
		switch x := t.(type) {
		case *ast.StarExpr:
			t = x.X
		case *ast.ParenExpr:
			t = x.X
		case *ast.IndexExpr:
			t = x.X
		case *ast.IndexListExpr:
			t = x.X
		case *ast.Ident:
			return x.Name
		default:
			return ""
		}
	}
}

// ── read ──
type pkg struct {
	types *types.Package
	info  *types.Info
	files []*ast.File
}

type reader struct {
	root, mod string
	fset      *token.FileSet
	std       types.Importer
	pkgs      map[string]*pkg // by directory, non-test files
}

func (r *reader) Import(path string) (*types.Package, error) {
	if path == r.mod || strings.HasPrefix(path, r.mod+"/") {
		p := r.check(filepath.Join(r.root, strings.TrimPrefix(strings.TrimPrefix(path, r.mod), "/")), path, false)
		return p.types, nil
	}
	return r.std.Import(path)
}

func newInfo() *types.Info {
	return &types.Info{Types: map[ast.Expr]types.TypeAndValue{}, Defs: map[*ast.Ident]types.Object{}, Uses: map[*ast.Ident]types.Object{}}
}

// goFiles: the directory's .go files that build here, tests or not.
func goFiles(dir string, tests bool) []string {
	ents, _ := os.ReadDir(dir)
	var out []string
	for _, e := range ents {
		n := e.Name()
		if e.IsDir() || !strings.HasSuffix(n, ".go") || strings.HasSuffix(n, "_test.go") != tests {
			continue
		}
		if ok, _ := build.Default.MatchFile(dir, n); ok {
			out = append(out, filepath.Join(dir, n))
		}
	}
	return out
}

func (r *reader) parse(paths []string) []*ast.File {
	var out []*ast.File
	for _, p := range paths {
		if f, err := parser.ParseFile(r.fset, p, nil, parser.ParseComments); f != nil {
			_ = err // a file with syntax errors still yields what parsed
			out = append(out, f)
		}
	}
	return out
}

func (r *reader) importPath(dir string) string {
	rel, _ := filepath.Rel(r.root, dir)
	if rel == "." {
		return r.mod
	}
	return r.mod + "/" + filepath.ToSlash(rel)
}

// check type-checks a package from source; type errors are ignored (what checks still has its types).
func (r *reader) check(dir, path string, _ bool) *pkg {
	if p, ok := r.pkgs[dir]; ok {
		return p
	}
	p := &pkg{info: newInfo(), files: r.parse(goFiles(dir, false))}
	r.pkgs[dir] = p // before checking: an import cycle ends here
	conf := types.Config{Importer: r, Error: func(error) {}}
	p.types, _ = conf.Check(path, r.fset, p.files, p.info)
	return p
}

func (r *reader) rel(pos token.Pos) string {
	rel, _ := filepath.Rel(r.root, r.fset.Position(pos).Filename)
	return filepath.ToSlash(rel)
}

func read(root string, dirs []string) any {
	root, _ = filepath.Abs(root)
	modText, err := os.ReadFile(filepath.Join(root, "go.mod"))
	if err != nil {
		return map[string]any{"error": err.Error()}
	}
	r := &reader{root: root, mod: modulePath(string(modText)), fset: token.NewFileSet(), std: importer.Default(), pkgs: map[string]*pkg{}}
	out := &Out{Module: r.mod, Files: map[string]*File{}, Uses: map[string]*Use{}, Lits: map[string][]Call{}}
	type scope struct {
		info  *types.Info
		files []*ast.File
	}
	var scopes []scope
	wanted, wantedTypes := map[string]bool{}, map[string]bool{}
	for _, d := range dirs {
		dir := filepath.Join(root, d)
		p := r.check(dir, r.importPath(dir), false)
		scopes = append(scopes, scope{p.info, p.files})
		for _, f := range p.files {
			fo := &File{Package: f.Name.Name, Imports: imports(f), Funcs: []Func{}, Types: []*Type{}, Tests: []string{}}
			out.Files[r.rel(f.Pos())] = fo
			for _, decl := range f.Decls {
				switch d := decl.(type) {
				case *ast.FuncDecl:
					if fn, ok := r.function(d, p); ok {
						fo.Funcs = append(fo.Funcs, fn)
						wanted[r.rel(f.Pos())+"\x00"+fn.Name] = true
						if fn.Recv != "" {
							wantedTypes[fn.Recv] = true
						}
					}
				case *ast.GenDecl:
					for _, s := range d.Specs {
						ts, ok := s.(*ast.TypeSpec)
						if !ok || !ts.Name.IsExported() || p.types == nil {
							continue
						}
						if obj := p.info.Defs[ts.Name]; obj != nil {
							if t := desc(obj.Type(), p.types, 0); t.K == "struct" {
								fo.Types = append(fo.Types, t)
							}
						}
					}
				}
			}
		}
		// tests: in the package (checked again with the test files) and the external `<name>_test` package
		tests := r.parse(goFiles(dir, true))
		var in, ext []*ast.File
		for _, f := range tests {
			if p.types != nil && f.Name.Name == p.types.Name() {
				in = append(in, f)
			} else {
				ext = append(ext, f)
			}
		}
		for gi, group := range [][]*ast.File{in, ext} {
			if len(group) == 0 {
				continue
			}
			files, path := group, r.importPath(dir)+"_test"
			if gi == 0 {
				files, path = append(append([]*ast.File{}, p.files...), in...), r.importPath(dir)
			}
			info := newInfo()
			conf := types.Config{Importer: r, Error: func(error) {}}
			conf.Check(path, r.fset, files, info)
			scopes = append(scopes, scope{info, group})
			for _, f := range group {
				fo := &File{Package: f.Name.Name, Imports: imports(f), Funcs: []Func{}, Types: []*Type{}, Tests: []string{}}
				for _, decl := range f.Decls {
					if fd, ok := decl.(*ast.FuncDecl); ok && fd.Recv == nil && strings.HasPrefix(fd.Name.Name, "Test") {
						fo.Tests = append(fo.Tests, fd.Name.Name)
					}
				}
				out.Files[r.rel(f.Pos())] = fo
			}
		}
	}
	// uses: test files that name a function, calls with literal arguments, composite literals of a method's type
	for _, s := range scopes {
		for _, f := range s.files {
			file := r.rel(f.Pos())
			isTest := strings.HasSuffix(file, "_test.go")
			ast.Inspect(f, func(n ast.Node) bool {
				switch x := n.(type) {
				case *ast.Ident:
					if k := r.key(s.info.Uses[x]); isTest && wanted[k] {
						u := use(out, k)
						if !contains(u.Tests, file) {
							u.Tests = append(u.Tests, file)
						}
					}
				case *ast.CallExpr:
					id, ok := x.Fun.(*ast.Ident)
					if sel, isSel := x.Fun.(*ast.SelectorExpr); isSel {
						id, ok = sel.Sel, true
					}
					if !ok || x.Ellipsis.IsValid() {
						break
					}
					if k := r.key(s.info.Uses[id]); wanted[k] {
						if args, ok := staticAll(s.info, x.Args); ok {
							u := use(out, k)
							u.Calls = append(u.Calls, Call{args, fmt.Sprintf("%s:%d", file, r.fset.Position(x.Pos()).Line)})
						}
					}
				case *ast.CompositeLit:
					named, ok := types.Unalias(s.info.Types[x].Type).(*types.Named)
					if !ok || !wantedTypes[named.Obj().Name()] || named.Obj().Pkg() == nil || !strings.HasPrefix(named.Obj().Pkg().Path(), r.mod) {
						break
					}
					if v, ok := static(s.info, x); ok {
						k := r.rel(named.Obj().Pos()) + "\x00" + named.Obj().Name()
						out.Lits[k] = append(out.Lits[k], Call{[]any{v}, fmt.Sprintf("%s:%d", file, r.fset.Position(x.Pos()).Line)})
					}
				}
				return true
			})
		}
	}
	for _, u := range out.Uses {
		sort.Strings(u.Tests)
	}
	return out
}

func use(out *Out, k string) *Use {
	if out.Uses[k] == nil {
		out.Uses[k] = &Use{Tests: []string{}, Calls: []Call{}}
	}
	return out.Uses[k]
}

func contains(l []string, s string) bool {
	for _, x := range l {
		if x == s {
			return true
		}
	}
	return false
}

// key: "<file>\x00<name>" of a function or method declared in the module, "" for anything else.
func (r *reader) key(obj types.Object) string {
	fn, ok := obj.(*types.Func)
	if !ok || fn.Pkg() == nil || !(fn.Pkg().Path() == r.mod || strings.HasPrefix(fn.Pkg().Path(), r.mod+"/")) {
		return ""
	}
	fn = fn.Origin()
	name := fn.Name()
	if recv := fn.Type().(*types.Signature).Recv(); recv != nil {
		t := recv.Type()
		if p, ok := t.(*types.Pointer); ok {
			t = p.Elem()
		}
		n, ok := types.Unalias(t).(*types.Named)
		if !ok {
			return ""
		}
		name = n.Obj().Name() + "." + name
	}
	return r.rel(fn.Pos()) + "\x00" + name
}

func imports(f *ast.File) []string {
	out := []string{}
	for _, s := range f.Imports {
		out = append(out, strings.Trim(s.Path.Value, "\"`"))
	}
	return out
}

func modulePath(gomod string) string {
	for _, l := range strings.Split(gomod, "\n") {
		if f := strings.Fields(l); len(f) >= 2 && f[0] == "module" {
			return strings.Trim(f[1], "\"`")
		}
	}
	return "main"
}

// function: an exported function, or an exported method of an exported type, of the package.
func (r *reader) function(d *ast.FuncDecl, p *pkg) (Func, bool) {
	recv := recvName(d)
	if !d.Name.IsExported() || d.Body == nil || (d.Recv != nil && (recv == "" || !ast.IsExported(recv))) || p.types == nil {
		return Func{}, false
	}
	obj, _ := p.info.Defs[d.Name].(*types.Func)
	if obj == nil {
		return Func{}, false
	}
	sig := obj.Type().(*types.Signature)
	fn := Func{Name: d.Name.Name, Recv: recv, Doc: doc(d.Doc), Params: []Param{}, Results: []*Type{}, Variadic: sig.Variadic(), Imports: map[string]string{},
		Decl: r.fset.Position(d.Pos()).Offset, Start: r.fset.Position(d.Body.Lbrace).Offset, End: r.fset.Position(d.Body.Rbrace).Offset + 1, Line: r.fset.Position(d.Pos()).Line,
		Generic: sig.TypeParams().Len() > 0 || sig.RecvTypeParams().Len() > 0}
	if recv != "" {
		fn.Name = recv + "." + fn.Name
	}
	qual := func(q *types.Package) string {
		if q == p.types {
			return ""
		}
		fn.Imports[q.Path()] = q.Name()
		return q.Name()
	}
	for i := 0; i < sig.Params().Len(); i++ {
		v := sig.Params().At(i)
		t := v.Type()
		if fn.Variadic && i == sig.Params().Len()-1 {
			t = t.(*types.Slice).Elem() // the harness declares the element: each trailing argument is one
		}
		name := v.Name()
		if name == "" || name == "_" {
			name = fmt.Sprintf("arg%d", i+1)
		}
		fn.Params = append(fn.Params, Param{name, desc(t, p.types, 0), types.TypeString(t, qual)})
	}
	errType := types.Universe.Lookup("error").Type()
	for i := 0; i < sig.Results().Len(); i++ {
		t := sig.Results().At(i).Type()
		if i == sig.Results().Len()-1 && types.Identical(t, errType) {
			fn.Error = true
			continue
		}
		fn.Results = append(fn.Results, desc(t, p.types, 0))
	}
	return fn, true
}

// doc: the doc comment's lines, at most 6, without blank lines and ponytail notes.
func doc(g *ast.CommentGroup) []string {
	out := []string{}
	if g == nil {
		return out
	}
	for _, l := range strings.Split(g.Text(), "\n") {
		if l = strings.TrimSpace(l); l != "" && !strings.HasPrefix(l, "ponytail:") && len(out) < 6 {
			out = append(out, l)
		}
	}
	return out
}

// desc: a type as go.ts maps it. A named type with its own JSON form (MarshalJSON, MarshalText) stays native.
func desc(t types.Type, pkg *types.Package, depth int) *Type {
	native := &Type{K: "native", Text: types.TypeString(t, func(q *types.Package) string {
		if q == pkg {
			return ""
		}
		return q.Name()
	})}
	if depth > 3 {
		return native
	}
	t = types.Unalias(t)
	if n, ok := t.(*types.Named); ok {
		for _, m := range []string{"MarshalJSON", "MarshalText", "UnmarshalJSON", "UnmarshalText"} {
			if obj, _, _ := types.LookupFieldOrMethod(types.NewPointer(n), true, n.Obj().Pkg(), m); obj != nil {
				return native
			}
		}
		if st, ok := n.Underlying().(*types.Struct); ok {
			if n.Obj().Pkg() != pkg || !n.Obj().Exported() || n.TypeArgs().Len() > 0 {
				return native
			}
			return &Type{K: "struct", Name: n.Obj().Name(), Fields: fields(st, pkg, depth)}
		}
	}
	switch u := t.Underlying().(type) {
	case *types.Basic:
		i := u.Info()
		switch {
		case i&types.IsInteger != 0:
			return &Type{K: "int"}
		case i&types.IsFloat != 0:
			return &Type{K: "float"}
		case i&types.IsString != 0:
			return &Type{K: "string"}
		case i&types.IsBoolean != 0:
			return &Type{K: "bool"}
		}
	case *types.Slice:
		if b, ok := u.Elem().Underlying().(*types.Basic); ok && b.Kind() == types.Byte {
			return native // encoding/json writes []byte as a base64 string
		}
		return &Type{K: "slice", Elem: desc(u.Elem(), pkg, depth+1)}
	case *types.Array:
		return &Type{K: "slice", Elem: desc(u.Elem(), pkg, depth+1)}
	case *types.Pointer:
		return &Type{K: "ptr", Elem: desc(u.Elem(), pkg, depth+1)}
	case *types.Interface:
		if u.Empty() {
			return &Type{K: "any"}
		}
	}
	return native
}

func fields(st *types.Struct, pkg *types.Package, depth int) []Field {
	out := []Field{}
	for i := 0; i < st.NumFields(); i++ {
		f := st.Field(i)
		name, skip, omit := jsonName(st, i)
		if skip {
			continue
		}
		out = append(out, Field{name, desc(f.Type(), pkg, depth+1), omit})
	}
	return out
}

// jsonName: a field's name as encoding/json writes it; skip for unexported, embedded and `json:"-"` fields.
// ponytail: an embedded struct's fields (which encoding/json flattens into the parent) are left out
func jsonName(st *types.Struct, i int) (name string, skip, omit bool) {
	f := st.Field(i)
	tag := reflect.StructTag(st.Tag(i)).Get("json")
	if !f.Exported() || f.Embedded() || tag == "-" {
		return "", true, false
	}
	parts := strings.Split(tag, ",")
	name = parts[0]
	if name == "" {
		name = f.Name()
	}
	for _, o := range parts[1:] {
		if o == "omitempty" || o == "omitzero" {
			omit = true
		}
	}
	return name, false, omit
}

// ── literal values ──
func staticAll(info *types.Info, args []ast.Expr) ([]any, bool) {
	out := []any{}
	for _, a := range args {
		v, ok := static(info, a)
		if !ok {
			return nil, false
		}
		out = append(out, v)
	}
	return out, true
}

// static: an expression's value as JSON when the code spells it out: constants, nil, and composite literals of them.
func static(info *types.Info, e ast.Expr) (any, bool) {
	if tv, ok := info.Types[e]; ok && tv.Value != nil {
		switch tv.Value.Kind() {
		case constant.Bool:
			return constant.BoolVal(tv.Value), true
		case constant.String:
			return constant.StringVal(tv.Value), true
		case constant.Int:
			if i, ok := constant.Int64Val(tv.Value); ok {
				return i, true
			}
			f, _ := constant.Float64Val(tv.Value)
			return f, true
		case constant.Float:
			f, _ := constant.Float64Val(tv.Value)
			return f, true
		}
		return nil, false
	}
	switch x := e.(type) {
	case *ast.ParenExpr:
		return static(info, x.X)
	case *ast.Ident:
		if x.Name == "nil" && info.Uses[x] == types.Universe.Lookup("nil") {
			return nil, true
		}
	case *ast.UnaryExpr:
		if cl, ok := x.X.(*ast.CompositeLit); ok && x.Op == token.AND {
			return static(info, cl)
		}
	case *ast.CompositeLit:
		t := info.Types[x].Type
		if t == nil {
			return nil, false
		}
		if p, ok := t.Underlying().(*types.Pointer); ok { // an element of []*T written as {...}
			t = p.Elem()
		}
		switch u := t.Underlying().(type) {
		case *types.Slice, *types.Array:
			out := []any{}
			for _, el := range x.Elts {
				if _, kv := el.(*ast.KeyValueExpr); kv {
					return nil, false
				}
				v, ok := static(info, el)
				if !ok {
					return nil, false
				}
				out = append(out, v)
			}
			return out, true
		case *types.Struct:
			out := map[string]any{}
			for i, el := range x.Elts {
				fi, val := i, el
				if kv, ok := el.(*ast.KeyValueExpr); ok {
					id, ok := kv.Key.(*ast.Ident)
					if !ok {
						return nil, false
					}
					fi, val = -1, kv.Value
					for j := 0; j < u.NumFields(); j++ {
						if u.Field(j).Name() == id.Name {
							fi = j
						}
					}
					if fi < 0 {
						return nil, false
					}
				}
				name, skip, _ := jsonName(u, fi)
				if skip {
					continue
				}
				v, ok := static(info, val)
				if !ok {
					return nil, false
				}
				out[name] = v
			}
			return out, true
		case *types.Map:
			if b, ok := u.Key().Underlying().(*types.Basic); !ok || b.Info()&types.IsString == 0 {
				return nil, false
			}
			out := map[string]any{}
			for _, el := range x.Elts {
				kv, ok := el.(*ast.KeyValueExpr)
				if !ok {
					return nil, false
				}
				k, ok1 := static(info, kv.Key)
				v, ok2 := static(info, kv.Value)
				ks, ok3 := k.(string)
				if !ok1 || !ok2 || !ok3 {
					return nil, false
				}
				out[ks] = v
			}
			return out, true
		}
	}
	return nil, false
}
