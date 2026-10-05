(fenced_code_block (info_string (language) @injection.language) (code_fence_content) @injection.content)
((html_block) @injection.content (#set! injection.language "html"))
([(inline) (pipe_table_cell) (notist_block)] @injection.content
 (#set! injection.language "notist_markdown_inline")
 (#set! injection.include-children))
