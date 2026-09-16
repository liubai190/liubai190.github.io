---
layout: default
title: 灰木
---

{::nomarkdown}
<div class="home-posts">
  <ul class="home-post-list">
    {%- for post in site.posts -%}
    <li>
      <a class="home-post-link" href="{{ post.url | relative_url }}">{{ post.title | escape }}</a>
      <span class="home-post-date">{{ post.date | date: "%Y/%-m/%-d" }}</span>
    </li>
    {%- endfor -%}
  </ul>

  <div class="dice-wrap">
    <button class="dice-btn" id="dice-btn" type="button" title="随便翻一篇" aria-label="随便翻一篇文章">
      <span class="dice-face">🎲</span>
    </button>
  </div>
</div>

<script>
  (function () {
    var btn = document.getElementById('dice-btn');
    if (!btn) { return; }

    /* 编号 1 = 最早发布，N = 最新。顺序与首页列表相反，所以用 reversed。 */
    var posts = [
      {%- for post in site.posts reversed -%}
      { t: {{ post.title | jsonify }}, u: {{ post.url | relative_url | jsonify }} }{%- unless forloop.last -%},{%- endunless -%}
      {%- endfor -%}
    ];

    var rolling = false;
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    btn.addEventListener('click', function () {
      if (rolling || !posts.length) { return; }
      rolling = true;
      btn.classList.add('is-rolling');
      btn.setAttribute('aria-busy', 'true');

      var n = Math.floor(Math.random() * posts.length) + 1;
      var rollMs = reduce ? 0 : 400;

      setTimeout(function () {
        window.location.href = posts[n - 1].u;
      }, rollMs);
    });
  })();
</script>
{:/nomarkdown}
