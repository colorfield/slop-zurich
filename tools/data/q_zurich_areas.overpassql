[out:json][timeout:120];
area["name"="Zürich"]["admin_level"="8"]->.city;
(
  relation["boundary"="administrative"]["admin_level"="10"](area.city)(47.35758,8.51214,47.39223,8.56315);
);
out geom;
