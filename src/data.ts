export type PhotoSpan = 'normal' | 'wide' | 'tall' | 'big';

/** 上传时从原图读出的拍摄参数，存进 photos.json */
export interface PhotoExif {
  camera?:   string;
  lens?:     string;
  focal?:    number;
  aperture?: number;
  shutter?:  number;
  iso?:      number;
  width?:    number;
  height?:   number;
  ev?:       number;
  shotAt?:   string;
}

export interface Photo {
  id: string;
  title: string;
  src: string;
  span: PhotoSpan;
  location?: string;
  year?: number;
  // 悬停叠色 — 呼应四类摄影的色彩气质：浓烈/清醒/热烈/恬淡
  tint: string;
  // 首屏背景只取其中一张
  cover?: boolean;
  exif?: PhotoExif;
}
// 20 张图片，span 模式精心排布，配合 grid-auto-flow: dense 形成视觉节奏
// export const PHOTOS: Photo[] = [
//   { id: '01', title: '午后的光', src: 'https://picsum.photos/seed/ph01/1200/800', span: 'wide', location: '北京', year: 2024, tint: 'rgba(220,80,60,0.25)' },
//   { id: '02', title: '沉默', src: 'https://picsum.photos/seed/ph02/800/1200', span: 'tall', location: '上海', year: 2024, tint: 'rgba(200,60,120,0.22)' },
//   { id: '03', title: '侧望', src: 'https://picsum.photos/seed/ph03/800/800', span: 'normal', location: '成都', year: 2023, tint: 'rgba(240,140,40,0.22)' },
//   { id: '04', title: '山间晨雾', src: 'https://picsum.photos/seed/ph04/1200/1200', span: 'big', location: '黄山', year: 2024, tint: 'rgba(40,120,200,0.22)' },
//   { id: '05', title: '老街巷口', src: 'https://picsum.photos/seed/ph05/800/800', span: 'normal', location: '西安', year: 2024, tint: 'rgba(200,120,20,0.22)' },
//   { id: '06', title: '初绽', src: 'https://picsum.photos/seed/ph06/800/800', span: 'normal', location: '北京', year: 2024, tint: 'rgba(220,40,180,0.22)' },
//   { id: '07', title: '渔火', src: 'https://picsum.photos/seed/ph07/1200/800', span: 'wide', location: '三亚', year: 2024, tint: 'rgba(40,80,180,0.25)' },
//   { id: '08', title: '晨练', src: 'https://picsum.photos/seed/ph08/800/800', span: 'normal', location: '重庆', year: 2023, tint: 'rgba(180,100,20,0.22)' },
//   { id: '09', title: '露珠', src: 'https://picsum.photos/seed/ph09/800/1200', span: 'tall', location: '云南', year: 2024, tint: 'rgba(40,160,100,0.22)' },
//   { id: '10', title: '热烈', src: 'https://picsum.photos/seed/ph10/800/800', span: 'normal', location: '昆明', year: 2023, tint: 'rgba(240,40,80,0.25)' },
//   { id: '11', title: '雪原', src: 'https://picsum.photos/seed/ph11/1200/800', span: 'wide', location: '西藏', year: 2023, tint: 'rgba(80,160,220,0.22)' },
//   { id: '12', title: '茶馆一隅', src: 'https://picsum.photos/seed/ph12/800/800', span: 'normal', location: '成都', year: 2023, tint: 'rgba(160,80,20,0.22)' },
//   { id: '13', title: '回眸', src: 'https://picsum.photos/seed/ph13/1200/1200', span: 'big', location: '杭州', year: 2023, tint: 'rgba(200,40,120,0.22)' },
//   { id: '14', title: '静湖', src: 'https://picsum.photos/seed/ph14/800/800', span: 'normal', location: '云南', year: 2023, tint: 'rgba(20,120,160,0.22)' },
//   { id: '15', title: '浮世芳', src: 'https://picsum.photos/seed/ph15/800/1200', span: 'tall', location: '苏州', year: 2022, tint: 'rgba(180,20,200,0.22)' },
//   { id: '16', title: '赶集', src: 'https://picsum.photos/seed/ph16/1200/800', span: 'wide', location: '云南', year: 2024, tint: 'rgba(200,100,20,0.22)' },
//   { id: '17', title: '暮色里的城', src: 'https://picsum.photos/seed/ph17/800/800', span: 'normal', location: '重庆', year: 2022, tint: 'rgba(80,40,160,0.25)' },
//   { id: '18', title: '晨光少年', src: 'https://picsum.photos/seed/ph18/800/800', span: 'normal', year: 2023, tint: 'rgba(220,80,60,0.22)' },
//   { id: '19', title: '码头工人', src: 'https://picsum.photos/seed/ph19/1200/800', span: 'wide', location: '武汉', year: 2022, tint: 'rgba(140,80,20,0.22)' },
//   { id: '20', title: '淡雅', src: 'https://picsum.photos/seed/ph20/800/800', span: 'normal', year: 2023, tint: 'rgba(140,200,180,0.22)' },
// ];