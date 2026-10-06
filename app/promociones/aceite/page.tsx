import type {Metadata} from 'next';
import {OilCampaign} from '@/components/oil-campaign';
import './campaign.css';
export const metadata:Metadata={title:'Mensajes de promoción · Lubricenter',robots:{index:false,follow:false}};
export default function Page(){return <OilCampaign/>;}
