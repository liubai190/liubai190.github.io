---
layout: default
title: 灰木
---

<div class="home-categories">

  {% for cat in site.data.categories %}
  <section class="category-section">
    <h1>{{ cat.name }}</h1>
    <p class="category-note">{{ cat.note }}</p>
    <ul class="post-list">
      {% assign posts = site.categories[cat.name] | sort: "date" %}
      {%- for post in posts -%}
      <li>
        <h3><a href="{{ post.url | relative_url }}">{{ post.title | escape }}</a></h3>
      </li>
      {%- endfor -%}
    </ul>
    <a href="{{ '/category/' | append: cat.slug | relative_url }}" class="more-link">more</a>
  </section>
  {% endfor %}

</div>
