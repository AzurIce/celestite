(comment) @comment
(string) @string
(number) @number
(boolean) @constant.builtin
(escape) @string.escape
(explicit_break) @punctuation.special
(raw_inline) @string
(raw_content) @string
(raw_fence_start) @punctuation.special
(raw_fence_end) @punctuation.special
(math) @string.special
(heading_marker) @punctuation.special
(heading title: (title) @title)
(strong) @emphasis.strong
(emphasis) @emphasis
(strike) @strikethrough
(list_marker) @punctuation.special
(divider) @punctuation.special
(table_header) @title
(table_delimiter) @punctuation.special
(link_target) @link_text
(link_destination) @link_uri
(call name: (path) @function.call)
(named_argument name: (_) @variable.parameter)
(dict_entry key: (_) @property)
["(" ")" "[" "]" "[[" "]]"] @punctuation.bracket
["#" "!" "@" "@!" "|" "," ":" "::"] @punctuation.delimiter
["*" "_" "~"] @punctuation.special
(negative_number "-" @operator)
