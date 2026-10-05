;; From nvim-treesitter/nvim-treesitter
[
  (code_span)
  (link_title)
] @text.literal

[
  (emphasis_delimiter)
  (code_span_delimiter)
] @punctuation.delimiter

(emphasis) @text.emphasis

(strong_emphasis) @text.strong

[
  (link_destination)
  (uri_autolink)
] @text.uri

[
  (link_label)
  (link_text)
  (image_description)
] @text.reference

[
  (backslash_escape)
  (hard_line_break)
] @string.escape

(image ["!" "[" "]" "(" ")"] @punctuation.delimiter)
(inline_link ["[" "]" "(" ")"] @punctuation.delimiter)
(shortcut_link ["[" "]"] @punctuation.delimiter)

; NOTE: extension not enabled by default
; (wiki_link ["[" "|" "]"] @punctuation.delimiter)

(strikethrough) @text.strike
(comment) @comment
(string) @string
(number) @number
(boolean) @constant.builtin
(math) @string.special
(call name: (path) @function.call)
(named_argument name: (_) @variable.parameter)
(dict_entry key: (_) @property)
["(" ")" "[" "]"] @punctuation.bracket
["#" "@" "@!" "," ":" "::"] @punctuation.delimiter
(negative_number "-" @operator)
