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

    function reset() {
      rolling = false;
      btn.classList.remove('is-rolling');
      btn.removeAttribute('aria-busy');
    }

    btn.addEventListener('click', function () {
      if (rolling || !posts.length) { return; }
      rolling = true;
      btn.classList.add('is-rolling');
      btn.setAttribute('aria-busy', 'true');

      var n = Math.floor(Math.random() * posts.length) + 1;
      var rollMs = reduce ? 0 : 400;
      /* 转完停一下再跳，停顿沿用删气泡之前的 375ms */
      var holdMs = reduce ? 200 : 375;

      setTimeout(function () {
        /* 跳转前先把状态清干净。浏览器会把这一帧整个冻进往返缓存（bfcache），
           带 rolling=true 和 is-rolling 类一起冻。不清的话从文章页按后退回来，
           rolling 仍是 true，骰子点不动；类还在，动画也重放不了 */
        reset();
        window.location.href = posts[n - 1].u;
      }, rollMs + holdMs);
    });

    /* 从往返缓存恢复时再兜一次底 */
    window.addEventListener('pageshow', function (e) {
      if (e.persisted) { reset(); }
    });
  })();
</script>
{:/nomarkdown}
