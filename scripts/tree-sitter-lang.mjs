// =============================================================================
// tree-sitter-lang.mjs — per-language configurations for tree-sitter extraction
//
// Each language defines: file extensions, grammar WASM package path,
// and tree-sitter query strings for extracting symbols, imports, exports,
// calls, and rationale comments.
// =============================================================================

/**
 * Rationale comment patterns — language-agnostic regex applied to raw source.
 * Matches: // WHY: ..., # NOTE: ..., /* DECISION: ... *\/, etc.
 */
export const RATIONALE_PATTERNS = [
  /(?:\/\/|#|--|;)\s*(WHY|NOTE|DECISION|HACK|TODO|FIXME|XXX|PERF|SAFETY|WORKAROUND)\s*:?\s*(.+)/i,
  /\/\*\s*(WHY|NOTE|DECISION|HACK|TODO|FIXME|XXX|PERF|SAFETY|WORKAROUND)\s*:?\s*([\s\S]*?)\*\//gi,
];

/**
 * Comment prefix per language family — used for rationale detection.
 */
const COMMENT_STYLES = {
  clike: ['//', '/*'],
  hash: ['#'],
  lua: ['--'],
};

/**
 * Language configurations.
 *
 * `grammarPackage` is the export path from the `tree-sitter-wasms` npm package.
 * The extract script resolves it via import.meta.resolve() or createRequire().
 *
 * Tree-sitter queries use S-expression syntax. Each query captures specific
 * node types the extractor needs.
 */
export const LANGUAGE_CONFIG = {
  typescript: {
    extensions: ['.ts', '.tsx'],
    grammarPackage: 'tree-sitter-wasms/out/tree-sitter-typescript.wasm',
    commentStyle: COMMENT_STYLES.clike,
    queries: {
      // Classes and interfaces
      classes: `
        (class_declaration
          name: (type_identifier) @name) @class
        (interface_declaration
          name: (type_identifier) @name) @interface
      `,
      // Functions and methods
      functions: `
        (function_declaration
          name: (identifier) @name
          parameters: (formal_parameters) @params) @func
        (method_definition
          name: (property_identifier) @name
          parameters: (formal_parameters) @params) @method
        (arrow_function) @arrow
        (lexical_declaration
          (variable_declarator
            name: (identifier) @name
            value: (arrow_function
              parameters: (formal_parameters) @params))) @arrow_decl
      `,
      imports: `
        (import_statement
          source: (string) @source) @import
        (import_statement
          (import_clause
            (named_imports
              (import_specifier
                name: (identifier) @imported_name)))) @named_import
      `,
      // Export statements
      exports: `
        (export_statement) @export
      `,
      calls: `
        (call_expression
          function: [
            (identifier) @callee
            (member_expression
              property: (property_identifier) @callee)
          ]) @call
      `,
    },
  },

  javascript: {
    extensions: ['.js', '.jsx', '.mjs', '.cjs'],
    grammarPackage: 'tree-sitter-wasms/out/tree-sitter-javascript.wasm',
    commentStyle: COMMENT_STYLES.clike,
    queries: {
      classes: `
        (class_declaration
          name: (identifier) @name) @class
      `,
      functions: `
        (function_declaration
          name: (identifier) @name
          parameters: (formal_parameters) @params) @func
        (method_definition
          name: (property_identifier) @name
          parameters: (formal_parameters) @params) @method
        (lexical_declaration
          (variable_declarator
            name: (identifier) @name
            value: (arrow_function
              parameters: (formal_parameters) @params))) @arrow_decl
      `,
      imports: `
        (import_statement
          source: (string) @source) @import
        (call_expression
          function: (identifier) @require_fn
          arguments: (arguments (string) @source)
          (#eq? @require_fn "require")) @require_call
      `,
      exports: `
        (export_statement) @export
      `,
      calls: `
        (call_expression
          function: [
            (identifier) @callee
            (member_expression
              property: (property_identifier) @callee)
          ]) @call
      `,
    },
  },

  python: {
    extensions: ['.py'],
    grammarPackage: 'tree-sitter-wasms/out/tree-sitter-python.wasm',
    commentStyle: COMMENT_STYLES.hash,
    queries: {
      classes: `
        (class_definition
          name: (identifier) @name) @class
      `,
      functions: `
        (function_definition
          name: (identifier) @name
          parameters: (parameters) @params) @func
      `,
      imports: `
        (import_statement
          name: (dotted_name) @source) @import
        (import_from_statement
          module_name: (dotted_name) @source) @from_import
        (import_from_statement
          name: (dotted_name) @imported_name) @from_import_name
      `,
      exports: `
        (expression_statement
          (assignment
            left: (identifier) @name
            (#eq? @name "__all__"))) @all_export
      `,
      calls: `
        (call
          function: [
            (identifier) @callee
            (attribute
              attribute: (identifier) @callee)
          ]) @call
      `,
    },
  },

  go: {
    extensions: ['.go'],
    grammarPackage: 'tree-sitter-wasms/out/tree-sitter-go.wasm',
    commentStyle: COMMENT_STYLES.clike,
    queries: {
      classes: `
        (type_declaration
          (type_spec
            name: (type_identifier) @name
            type: (struct_type))) @struct
        (type_declaration
          (type_spec
            name: (type_identifier) @name
            type: (interface_type))) @interface
      `,
      functions: `
        (function_declaration
          name: (identifier) @name
          parameters: (parameter_list) @params) @func
        (method_declaration
          name: (field_identifier) @name
          parameters: (parameter_list) @params) @method
      `,
      imports: `
        (import_spec
          path: (interpreted_string_literal) @source) @import
      `,
      exports: ``,
      calls: `
        (call_expression
          function: [
            (identifier) @callee
            (selector_expression
              field: (field_identifier) @callee)
          ]) @call
      `,
    },
  },

  rust: {
    extensions: ['.rs'],
    grammarPackage: 'tree-sitter-wasms/out/tree-sitter-rust.wasm',
    commentStyle: COMMENT_STYLES.clike,
    queries: {
      classes: `
        (struct_item
          name: (type_identifier) @name) @struct
        (enum_item
          name: (type_identifier) @name) @enum
        (trait_item
          name: (type_identifier) @name) @trait
        (impl_item
          type: (type_identifier) @name) @impl
      `,
      functions: `
        (function_item
          name: (identifier) @name
          parameters: (parameters) @params) @func
      `,
      imports: `
        (use_declaration
          argument: (_) @source) @use
      `,
      exports: `
        (visibility_modifier) @pub
      `,
      calls: `
        (call_expression
          function: [
            (identifier) @callee
            (field_expression
              field: (field_identifier) @callee)
            (scoped_identifier
              name: (identifier) @callee)
          ]) @call
      `,
    },
  },

  java: {
    extensions: ['.java'],
    grammarPackage: 'tree-sitter-wasms/out/tree-sitter-java.wasm',
    commentStyle: COMMENT_STYLES.clike,
    queries: {
      classes: `
        (class_declaration
          name: (identifier) @name) @class
        (interface_declaration
          name: (identifier) @name) @interface
        (enum_declaration
          name: (identifier) @name) @enum
      `,
      functions: `
        (method_declaration
          name: (identifier) @name
          parameters: (formal_parameters) @params) @method
        (constructor_declaration
          name: (identifier) @name
          parameters: (formal_parameters) @params) @constructor
      `,
      imports: `
        (import_declaration
          (scoped_identifier) @source) @import
      `,
      exports: ``,
      calls: `
        (method_invocation
          name: (identifier) @callee) @call
      `,
    },
  },

  c: {
    extensions: ['.c', '.h'],
    grammarPackage: 'tree-sitter-wasms/out/tree-sitter-c.wasm',
    commentStyle: COMMENT_STYLES.clike,
    queries: {
      classes: `
        (struct_specifier
          name: (type_identifier) @name) @struct
        (enum_specifier
          name: (type_identifier) @name) @enum
        (type_definition
          declarator: (type_identifier) @name) @typedef
      `,
      functions: `
        (function_definition
          declarator: (function_declarator
            declarator: (identifier) @name
            parameters: (parameter_list) @params)) @func
      `,
      imports: `
        (preproc_include
          path: (_) @source) @include
      `,
      exports: ``,
      calls: `
        (call_expression
          function: (identifier) @callee) @call
      `,
    },
  },

  cpp: {
    extensions: ['.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx'],
    grammarPackage: 'tree-sitter-wasms/out/tree-sitter-cpp.wasm',
    commentStyle: COMMENT_STYLES.clike,
    queries: {
      classes: `
        (class_specifier
          name: (type_identifier) @name) @class
        (struct_specifier
          name: (type_identifier) @name) @struct
      `,
      functions: `
        (function_definition
          declarator: (function_declarator
            declarator: [
              (identifier) @name
              (qualified_identifier
                name: (identifier) @name)
              (field_identifier) @name
            ]
            parameters: (parameter_list) @params)) @func
      `,
      imports: `
        (preproc_include
          path: (_) @source) @include
      `,
      exports: ``,
      calls: `
        (call_expression
          function: [
            (identifier) @callee
            (field_expression
              field: (field_identifier) @callee)
            (qualified_identifier
              name: (identifier) @callee)
          ]) @call
      `,
    },
  },
};

/**
 * Build extension → language lookup map.
 */
export function buildExtensionMap() {
  const map = new Map();
  for (const [lang, config] of Object.entries(LANGUAGE_CONFIG)) {
    for (const ext of config.extensions) {
      map.set(ext, lang);
    }
  }
  return map;
}
