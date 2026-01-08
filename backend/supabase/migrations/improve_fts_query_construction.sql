-- Migration: Improve FTS query construction in search_document_chunks_hybrid
-- Issue: Function uses prefix matching for all tokens, causing poor precision
-- Fix: Use exact matching for longer terms (4+ chars), prefix matching only for short terms (3 chars)
-- Date: 2026-01-08

create or replace function search_document_chunks_hybrid(
  search_query text,
  query_embedding vector(1536),
  result_limit integer default 10,
  result_offset integer default 0,
  rrf_k integer default 60,
  filter_year integer default null,
  filter_law_type text default null,
  filter_ministry text default null
)
returns table (
  id bigint,
  document_id bigint,
  chunk_index integer,
  content text,
  archive_filename text,
  member text,
  document_title text,
  document_date text,
  section_title text,
  section_number text,
  law_type text,
  year integer,
  ministry text,
  fts_rank real,
  vector_distance real,
  rrf_score real
)
language plpgsql
as $$
declare
  fts_query text;
  tokens text[];
  token_query text;
begin
  -- Extract tokens from search query for FTS
  -- Use regex to extract words (3+ characters) for better tokenization
  tokens := array(
    select lower(token)
    from regexp_split_to_table(lower(trim(search_query)), '\s+') as token
    where length(token) >= 3
  );

  -- Build FTS query with improved precision:
  -- - Use exact matching for terms 4+ characters (better precision)
  -- - Use prefix matching only for 3-character terms (for variations)
  -- This prevents false matches like "deling" in "ikraftsetting" matching "skjevdeling"
  fts_query := array_to_string(
    array(
      select case
        when length(token) >= 4 then
          -- Longer terms: use exact matching for better precision
          token
        else
          -- Very short terms (3 chars): use prefix matching for variations
          token || ':*'
      end
      from unnest(tokens) as token
      where length(token) > 0
    ),
    ' & '
  );

  -- For multi-word queries, also add phrase matching for better relevance
  if array_length(tokens, 1) > 1 then
    -- Build phrase query with <-> operator (followed by)
    token_query := array_to_string(
      array(
        select case
          when length(token) >= 4 then token
          else token || ':*'
        end
        from unnest(tokens) as token
      ),
      ' <-> '
    );
    -- Combine phrase and AND queries with OR for better recall
    fts_query := '(' || token_query || ') | (' || fts_query || ')';
  end if;

  if fts_query is null or fts_query = '' then
    fts_query := '';
  end if;

  -- Perform hybrid search with RRF on chunks with metadata filters
  return query
  with
  -- Full-text search results with metadata filters
  fts_results as (
    select
      c.id,
      c.document_id,
      c.chunk_index,
      c.content,
      c.archive_filename,
      c.member,
      c.document_title,
      c.document_date,
      c.section_title,
      c.section_number,
      c.law_type,
      c.year,
      c.ministry,
      ts_rank(c.tsv_content, to_tsquery('norwegian', fts_query))::real as rank
    from public.document_chunks c
    where (fts_query = '' or c.tsv_content @@ to_tsquery('norwegian', fts_query))
      and (filter_year is null or c.year = filter_year)
      and (filter_law_type is null or c.law_type = filter_law_type)
      and (filter_ministry is null or c.ministry = filter_ministry)
    order by rank desc
    limit result_limit * 2
  ),
  -- Vector search results with metadata filters
  vector_results as (
    select
      c.id,
      c.document_id,
      c.chunk_index,
      c.content,
      c.archive_filename,
      c.member,
      c.document_title,
      c.document_date,
      c.section_title,
      c.section_number,
      c.law_type,
      c.year,
      c.ministry,
      (1 - (c.embedding <=> query_embedding))::real as similarity
    from public.document_chunks c
    where c.embedding is not null
      and (filter_year is null or c.year = filter_year)
      and (filter_law_type is null or c.law_type = filter_law_type)
      and (filter_ministry is null or c.ministry = filter_ministry)
    order by c.embedding <=> query_embedding
    limit result_limit * 2
  ),
  -- Assign ranks
  fts_ranked as (
    select
      *,
      row_number() over (order by rank desc nulls last) as fts_rank_pos
    from fts_results
  ),
  vector_ranked as (
    select
      *,
      row_number() over (order by similarity desc nulls last) as vector_rank_pos
    from vector_results
  ),
  -- Combine and calculate RRF scores
  combined_results as (
    select
      coalesce(fts.id, vec.id) as id,
      coalesce(fts.document_id, vec.document_id) as document_id,
      coalesce(fts.chunk_index, vec.chunk_index) as chunk_index,
      coalesce(fts.content, vec.content) as content,
      coalesce(fts.archive_filename, vec.archive_filename) as archive_filename,
      coalesce(fts.member, vec.member) as member,
      coalesce(fts.document_title, vec.document_title) as document_title,
      coalesce(fts.document_date, vec.document_date) as document_date,
      coalesce(fts.section_title, vec.section_title) as section_title,
      coalesce(fts.section_number, vec.section_number) as section_number,
      coalesce(fts.law_type, vec.law_type) as law_type,
      coalesce(fts.year, vec.year) as year,
      coalesce(fts.ministry, vec.ministry) as ministry,
      fts.rank::real as fts_rank,
      vec.similarity::real as vector_distance,
      (coalesce(1.0 / (rrf_k + fts.fts_rank_pos), 0.0) +
       coalesce(1.0 / (rrf_k + vec.vector_rank_pos), 0.0))::real as rrf_score
    from fts_ranked fts
    full outer join vector_ranked vec on fts.id = vec.id
  )
  select
    cr.id,
    cr.document_id,
    cr.chunk_index,
    cr.content,
    cr.archive_filename,
    cr.member,
    cr.document_title,
    cr.document_date,
    cr.section_title,
    cr.section_number,
    cr.law_type,
    cr.year,
    cr.ministry,
    cr.fts_rank,
    cr.vector_distance,
    cr.rrf_score
  from combined_results cr
  order by cr.rrf_score desc, cr.fts_rank desc nulls last, cr.vector_distance desc nulls last
  limit result_limit
  offset result_offset;
end;
$$;

-- Grant execute permission
grant execute on function search_document_chunks_hybrid to service_role;

-- Comment
comment on function search_document_chunks_hybrid is 
'Hybrid search on document chunks combining FTS and vector search using RRF with metadata filtering support.
Improved FTS query construction: exact matching for 4+ char terms, prefix matching only for 3-char terms.
Supports filtering by year, law_type, and ministry.';

