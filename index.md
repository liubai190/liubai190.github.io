---
layout: default
title: 灰木
---

<div class="home-posts">
  <ul class="home-post-list">
    {%- for post in site.posts -%}
    <li>
      <a class="home-post-link" href="{{ post.url | relative_url }}">{{ post.title | escape }}</a>
      <span class="home-post-date">{{ post.date | date: "%Y/%-m/%-d" }}</span>
    </li>
    {%- endfor -%}
  </ul>
</div>
