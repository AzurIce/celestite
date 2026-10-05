(comment) @comment
(string) @string
(number) @number
(boolean) @constant.builtin
(fn_keyword) @keyword
(function_declaration name: (identifier) @function)
(parameter name: (identifier) @variable.parameter)
(type name: (path) @type)
(dict_entry key: (_) @property)
["(" ")" "[" "]" "<" ">"] @punctuation.bracket
[";" "," ":" "::"] @punctuation.delimiter
["->" "=" "?" "-"] @operator
"children" @variable.builtin
